const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { execFile, spawn, exec } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const crypto = require('crypto');
const os = require('os');

const execFileAsync = promisify(execFile);
const execAsync = promisify(exec);

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST', 'OPTIONS'] },
  transports: ['websocket', 'polling'],
  pingTimeout: 60000,
  pingInterval: 25000,
  upgradeTimeout: 30000,
  perMessageDeflate: false,
  maxHttpBufferSize: 1e8,
});

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// ─── CORS ─────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Range');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ─── CONSTANTS ────────────────────────────────────────────────────
const HOME = process.env.HOME || os.homedir() || '/tmp';
const LOCAL_BIN = path.join(HOME, '.local', 'bin');
const CACHE_DIR = path.join(HOME, '.yt-cache');
const URL_CACHE_TTL = 25 * 60 * 1000;

// Create directories
[LOCAL_BIN, CACHE_DIR].forEach(dir => {
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { /* ok */ }
});

// ─── USER AGENTS ──────────────────────────────────────────────────
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:127.0) Gecko/20100101 Firefox/127.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:127.0) Gecko/20100101 Firefox/127.0',
];

function randomUA() { return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)]; }

// ─── HEALTH CHECK ────────────────────────────────────────────────
app.get('/health', async (req, res) => {
  const bin = await findYtDlp();
  let ytdlpVersion = null;
  if (bin) {
    try {
      const { stdout } = await execFileAsync(bin, ['--version'], { timeout: 5000 });
      ytdlpVersion = stdout.trim();
    } catch (e) { /* ok */ }
  }
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    rooms: Object.keys(rooms).length,
    ytdlp: ytdlpVersion || 'not installed',
    ytdlpPath: bin || 'none',
    node: process.version,
    platform: os.platform(),
    memory: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + 'MB',
  });
});

// ─── yt-dlp BINARY MANAGEMENT ────────────────────────────────────
let _ytdlpBin = null;
let _ytdlpChecked = false;
let _installPromise = null;

function getYtDlpCandidates() {
  return [
    path.join(LOCAL_BIN, 'yt-dlp'),
    path.join(__dirname, 'yt-dlp'),
    '/usr/local/bin/yt-dlp',
    '/usr/bin/yt-dlp',
    path.join(HOME, '.local/bin/yt-dlp'),
    '/opt/render/.local/bin/yt-dlp',
    'yt-dlp',
  ];
}

async function findYtDlp() {
  if (_ytdlpBin) {
    try {
      await execFileAsync(_ytdlpBin, ['--version'], { timeout: 8000 });
      return _ytdlpBin;
    } catch (e) {
      console.warn('[yt-dlp] Cached binary no longer works:', _ytdlpBin);
      _ytdlpBin = null;
    }
  }

  for (const bin of getYtDlpCandidates()) {
    try {
      const { stdout } = await execFileAsync(bin, ['--version'], { timeout: 8000 });
      _ytdlpBin = bin;
      console.log(`[yt-dlp] Found: ${bin} (v${stdout.trim()})`);
      return bin;
    } catch (e) { /* try next */ }
  }

  // Also try "which" as last resort
  try {
    const { stdout } = await execAsync('which yt-dlp', { timeout: 5000 });
    const p = stdout.trim();
    if (p) {
      await execFileAsync(p, ['--version'], { timeout: 5000 });
      _ytdlpBin = p;
      console.log('[yt-dlp] Found via which:', p);
      return p;
    }
  } catch (e) { /* ok */ }

  return null;
}

async function installYtDlp() {
  // Prevent concurrent installations
  if (_installPromise) return _installPromise;

  _installPromise = (async () => {
    console.log('[yt-dlp] ===== INSTALLING =====');

    const dest = path.join(LOCAL_BIN, 'yt-dlp');

    // Strategy 1: Direct binary download (fastest, most reliable on Render)
    try {
      console.log('[yt-dlp] Strategy 1: Direct binary download...');
      await execAsync(
        `curl -L --max-time 60 --retry 3 "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp" -o "${dest}"`,
        { timeout: 90000 }
      );
      fs.chmodSync(dest, '755');
      const { stdout } = await execFileAsync(dest, ['--version'], { timeout: 10000 });
      _ytdlpBin = dest;
      console.log(`[yt-dlp] ✅ Installed via curl: v${stdout.trim()}`);
      return dest;
    } catch (e) {
      console.warn('[yt-dlp] Strategy 1 failed:', e.message?.slice(0, 100));
    }

    // Strategy 2: pip install
    const pipCmds = ['pip3', 'pip', 'python3 -m pip', 'python -m pip'];
    for (const pip of pipCmds) {
      try {
        console.log(`[yt-dlp] Strategy 2: ${pip} install...`);
        await execAsync(`${pip} install --user --break-system-packages yt-dlp 2>/dev/null || ${pip} install --user yt-dlp`, {
          timeout: 120000,
          env: { ...process.env, PATH: `${LOCAL_BIN}:${process.env.PATH}` }
        });
        _ytdlpBin = null; // reset to re-find
        const found = await findYtDlp();
        if (found) {
          console.log(`[yt-dlp] ✅ Installed via ${pip}`);
          return found;
        }
      } catch (e) {
        console.warn(`[yt-dlp] ${pip} failed:`, e.message?.slice(0, 80));
      }
    }

    // Strategy 3: wget fallback
    try {
      console.log('[yt-dlp] Strategy 3: wget...');
      await execAsync(
        `wget -q --timeout=60 "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp" -O "${dest}" && chmod +x "${dest}"`,
        { timeout: 90000 }
      );
      const { stdout } = await execFileAsync(dest, ['--version'], { timeout: 10000 });
      _ytdlpBin = dest;
      console.log(`[yt-dlp] ✅ Installed via wget: v${stdout.trim()}`);
      return dest;
    } catch (e) {
      console.warn('[yt-dlp] Strategy 3 failed:', e.message?.slice(0, 80));
    }

    // Strategy 4: pipx
    try {
      console.log('[yt-dlp] Strategy 4: pipx...');
      await execAsync('pipx install yt-dlp 2>/dev/null || pip3 install --user pipx && pipx install yt-dlp', { timeout: 120000 });
      _ytdlpBin = null;
      const found = await findYtDlp();
      if (found) return found;
    } catch (e) {
      console.warn('[yt-dlp] Strategy 4 failed:', e.message?.slice(0, 80));
    }

    throw new Error('All yt-dlp installation methods failed. Check server logs.');
  })();

  try {
    const result = await _installPromise;
    return result;
  } finally {
    _installPromise = null;
  }
}

async function ensureYtDlp() {
  const bin = await findYtDlp();
  if (bin) return bin;
  return await installYtDlp();
}

// ─── URL CACHE ───────────────────────────────────────────────────
const urlCache = new Map();

function getCacheKey(url) { return crypto.createHash('md5').update(url).digest('hex'); }

function getCached(url) {
  const key = getCacheKey(url);
  const entry = urlCache.get(key);
  if (entry && Date.now() - entry.time < URL_CACHE_TTL) return entry;
  urlCache.delete(key);
  return null;
}

function setCache(url, data) {
  urlCache.set(getCacheKey(url), { ...data, time: Date.now() });
  // Cleanup
  if (urlCache.size > 300) {
    const now = Date.now();
    for (const [k, v] of urlCache) {
      if (now - v.time > URL_CACHE_TTL) urlCache.delete(k);
    }
  }
}

// ─── YouTube URL helpers ─────────────────────────────────────────
function isYouTubeUrl(url) {
  try {
    const u = new URL(url);
    return ['youtube.com', 'www.youtube.com', 'youtu.be', 'm.youtube.com',
            'music.youtube.com', 'www.youtube-nocookie.com'].includes(u.hostname);
  } catch { return false; }
}

function extractVideoId(url) {
  try {
    const u = new URL(url);
    if (u.hostname === 'youtu.be') return u.pathname.slice(1).split('/')[0].split('?')[0];
    if (u.pathname.includes('/embed/')) return u.pathname.split('/embed/')[1].split('/')[0].split('?')[0];
    if (u.pathname.includes('/shorts/')) return u.pathname.split('/shorts/')[1].split('/')[0].split('?')[0];
    return u.searchParams.get('v') || null;
  } catch { return null; }
}

function normalizeYTUrl(url) {
  const id = extractVideoId(url);
  return id ? `https://www.youtube.com/watch?v=${id}` : url;
}

// ─── yt-dlp BASE ARGUMENTS ──────────────────────────────────────
function baseArgs() {
  return [
    '--no-playlist',
    '--no-warnings',
    '--no-check-certificates',
    '--prefer-free-formats',
    '--geo-bypass',
    '--no-cache-dir',
    '--extractor-retries', '3',
    '--socket-timeout', '20',
    '--user-agent', randomUA(),
    '--referer', 'https://www.youtube.com/',
    '--add-header', 'Accept-Language:en-US,en;q=0.9',
    '--add-header', 'Accept:text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    '--add-header', 'DNT:1',
  ];
}

// ─── MULTI-STRATEGY EXTRACTION ──────────────────────────────────
async function tryExtract(bin, url, formatStr, extraArgs = []) {
  const args = [
    ...baseArgs(),
    '--skip-download',
    '--dump-json',
    '--quiet',
    '-f', formatStr,
    ...extraArgs,
    url,
  ];

  const { stdout } = await execFileAsync(bin, args, {
    timeout: 35000,
    maxBuffer: 15 * 1024 * 1024,
    env: {
      ...process.env,
      PATH: `${LOCAL_BIN}:${process.env.PATH}`,
      HOME,
    },
  });

  const info = JSON.parse(stdout.trim());
  return {
    title: info.title || info.fulltitle || 'Unknown',
    duration: info.duration || 0,
    directUrl: info.url || null,
    ext: info.ext || info.audio_ext || 'webm',
    acodec: info.acodec || 'unknown',
    thumbnail: info.thumbnail || null,
    uploader: info.uploader || info.channel || '',
    videoId: info.id || extractVideoId(url),
    filesize: info.filesize || info.filesize_approx || 0,
    format: info.format || '',
  };
}

async function getYouTubeInfo(originalUrl) {
  const url = normalizeYTUrl(originalUrl);

  // Check cache
  const cached = getCached(url);
  if (cached) {
    console.log('[YT] Cache hit:', cached.title?.slice(0, 40));
    return cached;
  }

  let bin;
  try {
    bin = await ensureYtDlp();
  } catch (e) {
    throw new Error('yt-dlp is not available on this server. ' + e.message);
  }

  console.log('[YT] Extracting:', url.slice(0, 70));

  // Strategy chain — each tries different format strings and flags
  const strategies = [
    { name: 'bestaudio-m4a', fmt: 'bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio', extra: [] },
    { name: 'bestaudio-any', fmt: 'bestaudio/best', extra: [] },
    { name: 'worst-audio',   fmt: 'worstaudio/worst', extra: [] },
    { name: 'ba-sort-acodec', fmt: 'ba/b', extra: ['--format-sort', 'acodec:aac'] },
    { name: 'no-format',     fmt: 'best', extra: ['--extract-audio'] },
  ];

  // Also try alternate URL forms
  const videoId = extractVideoId(url);
  const urls = [url];
  if (videoId) {
    urls.push(`https://youtube.com/watch?v=${videoId}`);
    urls.push(`https://m.youtube.com/watch?v=${videoId}`);
  }

  let lastError = null;

  for (const tryUrl of urls) {
    for (const strat of strategies) {
      try {
        console.log(`[YT]   → ${strat.name} @ ${tryUrl.slice(0, 50)}`);
        const result = await tryExtract(bin, tryUrl, strat.fmt, strat.extra);
        console.log(`[YT]   ✅ "${result.title}" (${result.ext}, ${strat.name})`);
        setCache(url, result);
        return result;
      } catch (e) {
        lastError = e;
        const msg = (e.stderr || e.message || '').toString().slice(0, 120);
        console.log(`[YT]   ✗ ${strat.name}: ${msg}`);
        // If it's a definitive error (private, unavailable), don't try more strategies
        if (msg.includes('Private video') || msg.includes('Video unavailable') ||
            msg.includes('has been removed') || msg.includes('copyright')) {
          throw makeYTError(msg);
        }
      }
    }
  }

  throw makeYTError(lastError?.stderr || lastError?.message || 'All extraction strategies failed');
}

function makeYTError(raw) {
  const msg = raw.toString().slice(0, 500);
  if (msg.includes('Sign in') || msg.includes('bot') || msg.includes('confirm your age'))
    return new Error('YouTube is blocking this request. The video may require sign-in or age verification. Try a different video.');
  if (msg.includes('not available') || msg.includes('unavailable') || msg.includes('removed'))
    return new Error('This video is not available. It may be region-locked, removed, or private.');
  if (msg.includes('Private'))
    return new Error('This video is private and cannot be played.');
  if (msg.includes('copyright') || msg.includes('blocked'))
    return new Error('This video is blocked due to copyright restrictions in this region.');
  if (msg.includes('age'))
    return new Error('This video requires age verification. Try a different video.');
  if (msg.includes('members only'))
    return new Error('This video is for channel members only.');
  if (msg.includes('premiere') || msg.includes('live'))
    return new Error('This video is a live stream or upcoming premiere and cannot be extracted.');
  if (msg.includes('Unable to extract') || msg.includes('ERROR'))
    return new Error('Could not extract audio from this video. Try a different one.');
  return new Error('YouTube extraction failed: ' + msg.slice(0, 200));
}

// ─── /yt-info ENDPOINT ──────────────────────────────────────────
app.get('/yt-info', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: 'No URL provided' });
  if (!isYouTubeUrl(url)) return res.status(400).json({ error: 'Not a valid YouTube URL' });

  try {
    const info = await getYouTubeInfo(url);
    res.json({
      ok: true,
      title: info.title,
      duration: info.duration,
      mimeType: info.ext === 'webm' ? 'audio/webm' : 'audio/mp4',
      thumbnail: info.thumbnail,
      uploader: info.uploader,
      hasDirectUrl: !!info.directUrl,
      format: info.format,
    });
  } catch (e) {
    console.error('[YT-INFO] ERROR:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ─── /yt-stream ENDPOINT ────────────────────────────────────────
app.get('/yt-stream', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).send('No URL');
  if (!isYouTubeUrl(url)) return res.status(400).send('Not a YouTube URL');

  let bin;
  try {
    bin = await ensureYtDlp();
  } catch (e) {
    return res.status(500).send('yt-dlp not available: ' + e.message);
  }

  const normalUrl = normalizeYTUrl(url);

  // Determine content type from cache if available
  const cached = getCached(normalUrl);
  let contentType = 'audio/webm';
  if (cached?.ext === 'm4a' || cached?.ext === 'mp4') contentType = 'audio/mp4';

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', contentType);
  res.setHeader('Transfer-Encoding', 'chunked');
  res.setHeader('Cache-Control', 'no-cache, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  const args = [
    ...baseArgs(),
    '--quiet',
    '-f', 'bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio/best',
    '-o', '-',
    normalUrl,
  ];

  console.log('[YT-STREAM] Start:', normalUrl.slice(0, 60));

  const proc = spawn(bin, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PATH: `${LOCAL_BIN}:${process.env.PATH}`, HOME },
  });

  let bytesStreamed = 0;
  let headerSent = false;

  proc.stdout.on('data', chunk => {
    bytesStreamed += chunk.length;
    // Detect format from magic bytes
    if (!headerSent) {
      headerSent = true;
      if (chunk.length >= 4) {
        if (chunk[0] === 0x1A && chunk[1] === 0x45 && chunk[2] === 0xDF && chunk[3] === 0xA3) {
          // WebM/Matroska
          if (!res.headersSent) res.setHeader('Content-Type', 'audio/webm');
        } else if (chunk.length >= 8 && chunk[4] === 0x66 && chunk[5] === 0x74 && chunk[6] === 0x79 && chunk[7] === 0x70) {
          // MP4/M4A (ftyp)
          if (!res.headersSent) res.setHeader('Content-Type', 'audio/mp4');
        }
      }
    }
  });

  proc.stdout.pipe(res);

  let stderrBuf = '';
  proc.stderr.on('data', d => { stderrBuf += d.toString(); });

  proc.on('error', e => {
    console.error('[YT-STREAM] Spawn error:', e.message);
    if (!res.headersSent) res.status(500).send('Stream error: ' + e.message);
    else res.end();
  });

  proc.on('close', code => {
    if (code !== 0) {
      console.warn(`[YT-STREAM] Exit ${code} (${bytesStreamed}B streamed)`);
      if (stderrBuf) console.warn('[YT-STREAM] stderr:', stderrBuf.slice(0, 400));
      if (!headerSent && !res.headersSent) {
        res.status(500).send('Stream failed: ' + (stderrBuf.slice(0, 200) || 'unknown error'));
      }
    } else {
      console.log(`[YT-STREAM] Done: ${(bytesStreamed / 1024 / 1024).toFixed(1)}MB`);
    }
    if (!res.writableEnded) res.end();
  });

  req.on('close', () => {
    try { proc.kill('SIGTERM'); } catch (e) { /* ok */ }
  });
});

// ─── /proxy ENDPOINT ─────────────────────────────────────────────
app.get('/proxy', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).send('No URL');

  try {
    const nodeFetch = require('node-fetch');

    const headers = {
      'User-Agent': randomUA(),
      'Accept': '*/*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'identity',
      'Connection': 'keep-alive',
    };

    if (req.headers.range) headers['Range'] = req.headers.range;

    // Handle YouTube googlevideo URLs with extra headers
    if (url.includes('googlevideo.com') || url.includes('youtube.com')) {
      headers['Origin'] = 'https://www.youtube.com';
      headers['Referer'] = 'https://www.youtube.com/';
    }

    const upstream = await nodeFetch(url, {
      headers,
      redirect: 'follow',
      timeout: 30000,
      compress: false,
    });

    if (!upstream.ok && upstream.status !== 206) {
      return res.status(upstream.status).send(`Upstream error: ${upstream.status} ${upstream.statusText}`);
    }

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');

    const ct = upstream.headers.get('content-type') || 'audio/mpeg';
    res.setHeader('Content-Type', ct);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.setHeader('X-Content-Type-Options', 'nosniff');

    const cl = upstream.headers.get('content-length');
    const cr = upstream.headers.get('content-range');
    if (cl) res.setHeader('Content-Length', cl);
    if (cr) res.setHeader('Content-Range', cr);

    res.status(upstream.status === 206 ? 206 : 200);
    upstream.body.pipe(res);

    upstream.body.on('error', () => { if (!res.writableEnded) res.end(); });
  } catch (e) {
    console.error('[PROXY] Error:', e.message);
    if (!res.headersSent) res.status(500).send('Proxy error: ' + e.message);
  }
});

// ─── /yt-search ENDPOINT (bonus: search YouTube) ────────────────
app.get('/yt-search', async (req, res) => {
  const q = req.query.q;
  if (!q) return res.status(400).json({ error: 'No query' });

  try {
    const bin = await ensureYtDlp();
    const args = [
      ...baseArgs(),
      '--dump-json',
      '--default-search', 'ytsearch5',
      '--flat-playlist',
      '--quiet',
      '--no-download',
      `ytsearch5:${q}`,
    ];

    const { stdout } = await execFileAsync(bin, args, { timeout: 20000, maxBuffer: 5 * 1024 * 1024 });
    const results = stdout.trim().split('\n').map(line => {
      try {
        const j = JSON.parse(line);
        return { id: j.id, title: j.title, duration: j.duration, url: j.url || j.webpage_url, uploader: j.uploader };
      } catch { return null; }
    }).filter(Boolean);

    res.json({ ok: true, results });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ─── AI ANALYSIS ENDPOINT ────────────────────────────────────────
app.post('/ai-analyze', (req, res) => {
  const { features } = req.body;
  if (!features) return res.status(400).json({ error: 'No features' });

  const { spectralCentroid, rms, zeroCrossings, bassRatio, highRatio } = features;

  let genre = 'unknown', mood = 'neutral', preset = 'flat';

  if (bassRatio > 0.6 && (features.tempo || 0) > 120) {
    genre = 'electronic'; mood = 'energetic'; preset = 'bass';
  } else if (spectralCentroid > 0.4 && zeroCrossings > 0.15) {
    genre = 'rock'; mood = 'intense'; preset = 'cinema';
  } else if (spectralCentroid < 0.15 && rms < 0.25) {
    genre = 'ambient'; mood = 'calm'; preset = 'atmos';
  } else if (highRatio > 0.35 && rms > 0.35) {
    genre = 'pop'; mood = 'upbeat'; preset = 'vocal';
  } else if (bassRatio > 0.45) {
    genre = 'hip-hop'; mood = 'groovy'; preset = 'bass';
  } else if (zeroCrossings < 0.06 && rms < 0.2) {
    genre = 'classical'; mood = 'serene'; preset = 'cinema';
  } else if (spectralCentroid > 0.2 && spectralCentroid < 0.4) {
    genre = 'jazz'; mood = 'smooth'; preset = 'vocal';
  }

  res.json({ genre, mood, suggestedPreset: preset, confidence: 0.72 });
});

// ─── DEBUG ENDPOINT ──────────────────────────────────────────────
app.get('/debug/ytdlp', async (req, res) => {
  const result = { candidates: getYtDlpCandidates(), found: null, version: null, errors: [] };

  for (const bin of result.candidates) {
    try {
      const { stdout } = await execFileAsync(bin, ['--version'], { timeout: 5000 });
      result.found = bin;
      result.version = stdout.trim();
      break;
    } catch (e) {
      result.errors.push({ bin, error: e.message?.slice(0, 100) });
    }
  }

  // Check PATH
  try {
    const { stdout } = await execAsync('echo $PATH', { timeout: 3000 });
    result.path = stdout.trim();
  } catch (e) { result.path = 'error: ' + e.message; }

  // Check if python is available
  for (const py of ['python3', 'python']) {
    try {
      const { stdout } = await execFileAsync(py, ['--version'], { timeout: 3000 });
      result.python = stdout.trim();
      break;
    } catch (e) { /* next */ }
  }

  // List LOCAL_BIN contents
  try {
    result.localBinContents = fs.readdirSync(LOCAL_BIN);
  } catch (e) { result.localBinContents = 'error: ' + e.message; }

  res.json(result);
});

// ─── ROOMS ───────────────────────────────────────────────────────
const rooms = {};
const ROOM_TTL = 6 * 60 * 60 * 1000;

function makeCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

setInterval(() => {
  const now = Date.now();
  let cleaned = 0;
  for (const [code, room] of Object.entries(rooms)) {
    if (now - room.createdAt > ROOM_TTL) {
      io.to(code).emit('room:host_left');
      delete rooms[code];
      cleaned++;
    }
  }
  for (const [k, v] of urlCache) {
    if (now - v.time > URL_CACHE_TTL) urlCache.delete(k);
  }
  if (cleaned > 0) console.log(`[GC] Cleaned ${cleaned} rooms. Active: ${Object.keys(rooms).length}`);
}, 15 * 60 * 1000);

// ─── SOCKET.IO ───────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`[+] ${socket.id}`);

  socket.on('ntp:ping', ({ clientTime }) => {
    socket.emit('ntp:pong', { clientTime, serverTime: Date.now() });
  });

  socket.on('keepalive', () => socket.emit('keepalive-ack'));

  socket.on('room:create', ({ name }, cb) => {
    if (typeof cb !== 'function') return;
    let code = makeCode(), tries = 0;
    while (rooms[code] && tries++ < 100) code = makeCode();

    rooms[code] = {
      host: socket.id,
      name: (name || 'Audio Room').slice(0, 50),
      listeners: [],
      track: null,
      state: { playing: false, position: 0, serverPlayAt: null },
      createdAt: Date.now(),
      aiState: { genre: null, mood: null, preset: 'flat' },
    };

    socket.join(code);
    socket.data.code = code;
    socket.data.isHost = true;
    console.log(`[ROOM] Created ${code} (total: ${Object.keys(rooms).length})`);
    cb({ ok: true, code, name: rooms[code].name });
  });

  socket.on('room:join', ({ code }, cb) => {
    if (typeof cb !== 'function') return;
    code = (code || '').toUpperCase().trim();
    const room = rooms[code];
    if (!room) return cb({ ok: false, error: 'Room not found. Check the code and make sure the host is online.' });
    if (room.listeners.length >= 50) return cb({ ok: false, error: 'Room is full (max 50 listeners).' });

    room.listeners.push(socket.id);
    socket.join(code);
    socket.data.code = code;
    socket.data.isHost = false;

    io.to(room.host).emit('room:listener_joined', { id: socket.id, count: room.listeners.length });
    io.to(code).emit('room:count', room.listeners.length);

    console.log(`[ROOM] ${socket.id} joined ${code} (listeners: ${room.listeners.length})`);
    cb({
      ok: true,
      name: room.name,
      track: room.track,
      state: room.state,
      aiState: room.aiState,
      listenerCount: room.listeners.length,
    });
  });

  socket.on('track:set', ({ streamUrl, title, originalUrl }) => {
    const room = rooms[socket.data.code];
    if (!room || room.host !== socket.id) return;
    room.track = { streamUrl, title, originalUrl };
    room.state = { playing: false, position: 0, serverPlayAt: null };
    socket.to(socket.data.code).emit('track:set', { streamUrl, title, originalUrl });
    console.log(`[TRACK] "${title}" in ${socket.data.code}`);
  });

  socket.on('ai:state', (data) => {
    const room = rooms[socket.data.code];
    if (!room || room.host !== socket.id) return;
    room.aiState = data;
    socket.to(socket.data.code).emit('ai:state', data);
  });

  socket.on('audio:play', ({ position, serverPlayAt }) => {
    const room = rooms[socket.data.code];
    if (!room || room.host !== socket.id) return;
    room.state = { playing: true, position, serverPlayAt };
    socket.to(socket.data.code).emit('audio:play', { position, serverPlayAt });
  });

  socket.on('audio:pause', ({ position }) => {
    const room = rooms[socket.data.code];
    if (!room || room.host !== socket.id) return;
    room.state = { playing: false, position, serverPlayAt: null };
    socket.to(socket.data.code).emit('audio:pause', { position });
  });

  socket.on('audio:seek', ({ position, playing, serverPlayAt }) => {
    const room = rooms[socket.data.code];
    if (!room || room.host !== socket.id) return;
    room.state = { playing, position, serverPlayAt: playing ? serverPlayAt : null };
    socket.to(socket.data.code).emit('audio:seek', { position, playing, serverPlayAt });
  });

  socket.on('disconnect', (reason) => {
    const code = socket.data.code;
    console.log(`[-] ${socket.id} (${reason})`);
    if (!code || !rooms[code]) return;

    if (socket.data.isHost) {
      io.to(code).emit('room:host_left');
      delete rooms[code];
      console.log(`[ROOM] Host left ${code} (total: ${Object.keys(rooms).length})`);
    } else {
      const room = rooms[code];
      room.listeners = room.listeners.filter(id => id !== socket.id);
      io.to(room.host).emit('room:listener_left', { id: socket.id, count: room.listeners.length });
      io.to(code).emit('room:count', room.listeners.length);
    }
  });
});

// ─── STARTUP ─────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', async () => {
  console.log(`🌊 WaveRoom v3.0 on port ${PORT}`);
  console.log(`   Node: ${process.version} | Platform: ${os.platform()} ${os.arch()}`);
  console.log(`   HOME: ${HOME}`);
  console.log(`   LOCAL_BIN: ${LOCAL_BIN}`);

  try {
    const bin = await ensureYtDlp();
    const { stdout } = await execFileAsync(bin, ['--version'], { timeout: 8000 });
    console.log(`✅ yt-dlp ready: v${stdout.trim()} at ${bin}`);
  } catch (e) {
    console.warn('⚠️  yt-dlp not available:', e.message);
    console.warn('   Will attempt install on first YouTube request');
  }
});
