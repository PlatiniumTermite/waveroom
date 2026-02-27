const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { execFile, spawn, exec } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const crypto = require('crypto');

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

// ─── CORS (before all routes) ────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Range');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ─── HEALTH CHECK ────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({
  status: 'ok',
  uptime: process.uptime(),
  rooms: Object.keys(rooms).length,
  ytdlp: !!_ytdlpBin,
  memory: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + 'MB',
}));

// ─── ROTATING USER AGENTS ────────────────────────────────────────
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:126.0) Gecko/20100101 Firefox/126.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:126.0) Gecko/20100101 Firefox/126.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0',
];

function randomUA() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

// ─── yt-dlp MANAGEMENT ──────────────────────────────────────────
let _ytdlpBin = null;
const YTDLP_VERSION_MINIMUM = '2024.01.01';
const COOKIE_FILE = path.join(process.env.HOME || '/tmp', '.yt-cookies.txt');
const CACHE_DIR = path.join(process.env.HOME || '/tmp', '.yt-cache');

// Ensure cache directory exists
try { fs.mkdirSync(CACHE_DIR, { recursive: true }); } catch (e) { /* ok */ }

function getYtDlpCandidates() {
  return [
    'yt-dlp',
    '/usr/local/bin/yt-dlp',
    '/usr/bin/yt-dlp',
    path.join(process.env.HOME || '/root', '.local/bin/yt-dlp'),
    path.join(__dirname, 'node_modules', '.bin', 'yt-dlp'),
    '/opt/render/.local/bin/yt-dlp',
  ];
}

async function findYtDlp() {
  if (_ytdlpBin) {
    try {
      await execFileAsync(_ytdlpBin, ['--version'], { timeout: 5000 });
      return _ytdlpBin;
    } catch (e) { _ytdlpBin = null; }
  }

  for (const bin of getYtDlpCandidates()) {
    try {
      const { stdout } = await execFileAsync(bin, ['--version'], { timeout: 5000 });
      _ytdlpBin = bin;
      console.log(`[yt-dlp] Found at: ${bin} (v${stdout.trim()})`);
      return bin;
    } catch (e) { /* try next */ }
  }
  return null;
}

async function installYtDlp() {
  console.log('[yt-dlp] Installing...');

  // Strategy 1: pip install (most reliable on Render)
  const pipCmds = ['pip3', 'pip', 'python3 -m pip', 'python -m pip'];
  for (const pip of pipCmds) {
    try {
      await execAsync(`${pip} install --quiet --user --upgrade yt-dlp`, { timeout: 120000 });
      _ytdlpBin = null;
      const found = await findYtDlp();
      if (found) { console.log(`[yt-dlp] Installed via ${pip}`); return found; }
    } catch (e) { /* try next */ }
  }

  // Strategy 2: Direct binary download
  const dest = path.join(process.env.HOME || '/tmp', '.local/bin/yt-dlp');
  try {
    await execAsync(`mkdir -p $(dirname ${dest})`, { timeout: 5000 });
    await execAsync(
      `curl -sL "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp" -o "${dest}" && chmod +x "${dest}"`,
      { timeout: 60000 }
    );
    _ytdlpBin = dest;
    console.log('[yt-dlp] Installed via curl to', dest);
    return dest;
  } catch (e) { console.warn('[yt-dlp] curl install failed:', e.message); }

  // Strategy 3: wget fallback
  try {
    const dest2 = '/tmp/yt-dlp';
    await execAsync(
      `wget -q "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp" -O "${dest2}" && chmod +x "${dest2}"`,
      { timeout: 60000 }
    );
    _ytdlpBin = dest2;
    console.log('[yt-dlp] Installed via wget to', dest2);
    return dest2;
  } catch (e) { console.warn('[yt-dlp] wget install failed:', e.message); }

  throw new Error('Could not install yt-dlp. All strategies failed.');
}

async function ensureYtDlp() {
  const bin = await findYtDlp();
  if (bin) return bin;
  return await installYtDlp();
}

// ─── URL EXTRACTION CACHE ────────────────────────────────────────
// Cache extracted URLs for 30 minutes to avoid repeated yt-dlp calls
const urlCache = new Map();
const URL_CACHE_TTL = 30 * 60 * 1000;

function getCacheKey(url) {
  return crypto.createHash('md5').update(url).digest('hex');
}

function getCachedUrl(url) {
  const key = getCacheKey(url);
  const entry = urlCache.get(key);
  if (entry && Date.now() - entry.time < URL_CACHE_TTL) return entry;
  urlCache.delete(key);
  return null;
}

function setCachedUrl(url, data) {
  const key = getCacheKey(url);
  urlCache.set(key, { ...data, time: Date.now() });
  // Cleanup old entries
  if (urlCache.size > 200) {
    const now = Date.now();
    for (const [k, v] of urlCache) {
      if (now - v.time > URL_CACHE_TTL) urlCache.delete(k);
    }
  }
}

// ─── YOUTUBE URL VALIDATION ──────────────────────────────────────
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
    if (u.hostname === 'youtu.be') return u.pathname.slice(1).split('/')[0];
    return u.searchParams.get('v') || u.pathname.split('/').pop();
  } catch { return null; }
}

// ─── yt-dlp BASE ARGS (anti-blocking) ───────────────────────────
function baseYtDlpArgs(url) {
  const args = [
    '--no-playlist',
    '--no-warnings',
    '--no-check-certificates',
    '--prefer-free-formats',
    '--geo-bypass',
    '--extractor-retries', '5',
    '--socket-timeout', '15',
    '--user-agent', randomUA(),
    '--referer', 'https://www.youtube.com/',
    '--add-header', 'Accept-Language:en-US,en;q=0.9',
    '--add-header', 'Accept:text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  ];

  // Use cookies file if it exists
  if (fs.existsSync(COOKIE_FILE)) {
    args.push('--cookies', COOKIE_FILE);
  }

  return args;
}

// ─── MULTI-STRATEGY AUDIO EXTRACTION ─────────────────────────────
// Each strategy tries a different approach to avoid YouTube blocking

async function extractStrategy1(bin, url) {
  // Strategy 1: Direct best audio extraction
  const args = [
    ...baseYtDlpArgs(url),
    '--skip-download',
    '--print-json',
    '--quiet',
    '-f', 'bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio/best',
    url
  ];
  const { stdout } = await execFileAsync(bin, args, { timeout: 30000, maxBuffer: 10 * 1024 * 1024 });
  return JSON.parse(stdout.trim());
}

async function extractStrategy2(bin, url) {
  // Strategy 2: Use --flat-playlist and get formats separately
  const args = [
    ...baseYtDlpArgs(url),
    '--skip-download',
    '--dump-json',
    '--quiet',
    '-f', 'ba/b',
    url
  ];
  const { stdout } = await execFileAsync(bin, args, { timeout: 30000, maxBuffer: 10 * 1024 * 1024 });
  return JSON.parse(stdout.trim());
}

async function extractStrategy3(bin, url) {
  // Strategy 3: Extract with different format selection
  const args = [
    ...baseYtDlpArgs(url),
    '--skip-download',
    '--print-json',
    '--quiet',
    '-f', 'worstaudio/worst',  // Sometimes works when best is blocked
    '--format-sort', 'acodec:aac',
    url
  ];
  const { stdout } = await execFileAsync(bin, args, { timeout: 30000, maxBuffer: 10 * 1024 * 1024 });
  return JSON.parse(stdout.trim());
}

async function extractStrategy4(bin, url) {
  // Strategy 4: Use --extract-audio with pipe-friendly options
  const videoId = extractVideoId(url);
  if (!videoId) throw new Error('Cannot extract video ID');

  // Try alternate URL formats
  const altUrls = [
    `https://www.youtube.com/watch?v=${videoId}`,
    `https://youtube.com/watch?v=${videoId}`,
    `https://m.youtube.com/watch?v=${videoId}`,
    `https://www.youtube-nocookie.com/embed/${videoId}`,
  ];

  for (const altUrl of altUrls) {
    try {
      const args = [
        ...baseYtDlpArgs(altUrl),
        '--skip-download',
        '--print-json',
        '--quiet',
        '-f', 'bestaudio/best',
        altUrl
      ];
      const { stdout } = await execFileAsync(bin, args, { timeout: 25000, maxBuffer: 10 * 1024 * 1024 });
      return JSON.parse(stdout.trim());
    } catch (e) { continue; }
  }
  throw new Error('All alternate URLs failed');
}

async function getYouTubeInfo(url) {
  // Check cache first
  const cached = getCachedUrl(url);
  if (cached) {
    console.log('[YT] Cache hit for:', url.slice(0, 50));
    return cached;
  }

  const bin = await ensureYtDlp();
  const strategies = [extractStrategy1, extractStrategy2, extractStrategy3, extractStrategy4];
  let lastError = null;

  for (let i = 0; i < strategies.length; i++) {
    try {
      console.log(`[YT] Strategy ${i + 1} for:`, url.slice(0, 50));
      const info = await strategies[i](bin, url);

      const result = {
        title: info.title || info.fulltitle || 'Unknown',
        duration: info.duration || 0,
        directUrl: info.url || info.requested_downloads?.[0]?.url || null,
        ext: info.ext || info.audio_ext || 'm4a',
        acodec: info.acodec || 'unknown',
        filesize: info.filesize || info.filesize_approx || 0,
        thumbnail: info.thumbnail || null,
        uploader: info.uploader || info.channel || '',
        videoId: info.id || extractVideoId(url),
      };

      setCachedUrl(url, result);
      console.log(`[YT] Strategy ${i + 1} succeeded: "${result.title}"`);
      return result;
    } catch (e) {
      lastError = e;
      console.warn(`[YT] Strategy ${i + 1} failed:`, e.message?.slice(0, 120));
    }
  }

  // Provide clear error messages
  const msg = lastError?.message || 'Unknown error';
  if (msg.includes('Sign in') || msg.includes('bot') || msg.includes('confirm'))
    throw new Error('YouTube is rate-limiting this server. Try again in a few minutes, or try a different video.');
  if (msg.includes('not available') || msg.includes('unavailable'))
    throw new Error('This video is not available. It may be region-locked or removed.');
  if (msg.includes('Private'))
    throw new Error('This video is private and cannot be played.');
  if (msg.includes('age'))
    throw new Error('This video requires age verification and cannot be streamed.');
  if (msg.includes('copyright') || msg.includes('blocked'))
    throw new Error('This video is blocked due to copyright restrictions.');

  throw new Error(`Failed to extract audio: ${msg.slice(0, 200)}`);
}

// ─── YOUTUBE INFO ENDPOINT ───────────────────────────────────────
app.get('/yt-info', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: 'No URL provided' });
  if (!isYouTubeUrl(url)) return res.status(400).json({ error: 'Not a valid YouTube URL' });

  try {
    const info = await getYouTubeInfo(url);
    res.json({
      title: info.title,
      duration: info.duration,
      mimeType: info.ext === 'webm' ? 'audio/webm' : 'audio/mp4',
      thumbnail: info.thumbnail,
      uploader: info.uploader,
      hasDirectUrl: !!info.directUrl,
    });
  } catch (e) {
    console.error('[YT-INFO] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── YOUTUBE DIRECT URL ENDPOINT ─────────────────────────────────
// Returns the direct audio URL for client-side playback
// This avoids server-side streaming bottlenecks
app.get('/yt-direct', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: 'No URL provided' });
  if (!isYouTubeUrl(url)) return res.status(400).json({ error: 'Not a valid YouTube URL' });

  try {
    const info = await getYouTubeInfo(url);
    if (info.directUrl) {
      res.json({ url: info.directUrl, title: info.title, ext: info.ext });
    } else {
      res.status(500).json({ error: 'Could not extract direct URL' });
    }
  } catch (e) {
    console.error('[YT-DIRECT] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── YOUTUBE STREAM (piped) ──────────────────────────────────────
// Fallback: pipe yt-dlp stdout directly to response
app.get('/yt-stream', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).send('No URL');
  if (!isYouTubeUrl(url)) return res.status(400).send('Not a YouTube URL');

  try {
    const bin = await ensureYtDlp();

    // Try to determine content type first
    let contentType = 'audio/mp4';
    const cached = getCachedUrl(url);
    if (cached?.ext === 'webm') contentType = 'audio/webm';

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', contentType);
    res.setHeader('Transfer-Encoding', 'chunked');
    res.setHeader('Cache-Control', 'no-cache, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');

    const args = [
      ...baseYtDlpArgs(url),
      '--quiet',
      '-f', 'bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio/best',
      '-o', '-',
      url
    ];

    console.log('[YT-STREAM] Starting for:', url.slice(0, 60));
    const proc = spawn(bin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }
    });

    let headerSent = false;
    let bytesStreamed = 0;

    proc.stdout.on('data', (chunk) => {
      if (!headerSent) {
        headerSent = true;
        // Detect actual format from first bytes
        if (chunk[0] === 0x1A && chunk[1] === 0x45) {
          // WebM/Matroska magic bytes
          res.setHeader('Content-Type', 'audio/webm');
        }
      }
      bytesStreamed += chunk.length;
    });

    proc.stdout.pipe(res);

    let stderrBuf = '';
    proc.stderr.on('data', d => { stderrBuf += d.toString(); });

    proc.on('error', e => {
      console.error('[YT-STREAM] spawn error:', e.message);
      if (!res.headersSent) res.status(500).send(e.message);
      else res.end();
    });

    proc.on('close', code => {
      if (code !== 0) {
        console.warn(`[YT-STREAM] exit ${code}, streamed ${bytesStreamed}B`);
        if (stderrBuf) console.warn('[YT-STREAM] stderr:', stderrBuf.slice(0, 500));
        if (!headerSent && !res.headersSent) {
          res.status(500).send('Stream failed: ' + stderrBuf.slice(0, 200));
        }
      } else {
        console.log(`[YT-STREAM] Complete: ${(bytesStreamed / 1024 / 1024).toFixed(1)}MB`);
      }
      res.end();
    });

    req.on('close', () => {
      try { proc.kill('SIGTERM'); } catch (e) { /* ok */ }
    });

  } catch (e) {
    console.error('[YT-STREAM] Fatal:', e.message);
    if (!res.headersSent) res.status(500).send(e.message);
  }
});

// ─── AUDIO PROXY (for direct URLs) ──────────────────────────────
app.get('/proxy', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).send('No URL');

  try {
    const nodeFetch = require('node-fetch');
    const reqHeaders = {
      'User-Agent': randomUA(),
      'Accept': 'audio/*,video/*,*/*;q=0.9',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'identity',
      'Connection': 'keep-alive',
    };

    if (req.headers.range) reqHeaders['Range'] = req.headers.range;

    // Follow redirects
    const upstream = await nodeFetch(url, {
      headers: reqHeaders,
      redirect: 'follow',
      timeout: 30000,
    });

    if (!upstream.ok && upstream.status !== 206) {
      return res.status(upstream.status).send('Upstream error: ' + upstream.status);
    }

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');

    // Forward relevant headers
    const ct = upstream.headers.get('content-type') || 'audio/mpeg';
    res.setHeader('Content-Type', ct);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'public, max-age=3600');

    const cl = upstream.headers.get('content-length');
    const cr = upstream.headers.get('content-range');
    if (cl) res.setHeader('Content-Length', cl);
    if (cr) res.setHeader('Content-Range', cr);

    res.status(upstream.status === 206 ? 206 : 200);
    upstream.body.pipe(res);

    upstream.body.on('error', (e) => {
      console.error('[PROXY] Stream error:', e.message);
      res.end();
    });

  } catch (e) {
    console.error('[PROXY] Error:', e.message);
    if (!res.headersSent) res.status(500).send('Proxy error: ' + e.message);
  }
});

// ─── AI ANALYSIS ENDPOINT ────────────────────────────────────────
// Server-side audio feature extraction hints for client AI
app.post('/ai-analyze', express.json(), (req, res) => {
  const { features } = req.body;
  if (!features) return res.status(400).json({ error: 'No features' });

  // Simple server-side genre/mood classification based on audio features
  // The real heavy lifting happens client-side with TensorFlow.js
  const { spectralCentroid, rms, zeroCrossings, tempo, bassRatio, highRatio } = features;

  let genre = 'unknown';
  let mood = 'neutral';
  let preset = 'flat';

  // Rule-based classification (supplementary to client-side ML)
  if (bassRatio > 0.6 && tempo > 120) {
    genre = 'electronic'; mood = 'energetic'; preset = 'bass';
  } else if (spectralCentroid > 3000 && zeroCrossings > 0.15) {
    genre = 'rock'; mood = 'intense'; preset = 'cinema';
  } else if (spectralCentroid < 1500 && rms < 0.3) {
    genre = 'ambient'; mood = 'calm'; preset = 'atmos';
  } else if (highRatio > 0.4 && rms > 0.4) {
    genre = 'pop'; mood = 'upbeat'; preset = 'vocal';
  } else if (bassRatio > 0.45 && spectralCentroid < 2000) {
    genre = 'hip-hop'; mood = 'groovy'; preset = 'bass';
  } else if (zeroCrossings < 0.08 && rms < 0.25) {
    genre = 'classical'; mood = 'serene'; preset = 'cinema';
  } else if (spectralCentroid > 2000 && spectralCentroid < 4000) {
    genre = 'jazz'; mood = 'smooth'; preset = 'vocal';
  }

  res.json({ genre, mood, suggestedPreset: preset, confidence: 0.72 });
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

// Periodic cleanup
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
  // Clean URL cache
  for (const [k, v] of urlCache) {
    if (now - v.time > URL_CACHE_TTL) urlCache.delete(k);
  }
  if (cleaned > 0) console.log(`[GC] Cleaned ${cleaned} rooms. Active: ${Object.keys(rooms).length}`);
}, 15 * 60 * 1000);

// ─── SOCKET.IO ───────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`[+] Socket: ${socket.id} from ${socket.handshake.address}`);

  // NTP time sync
  socket.on('ntp:ping', ({ clientTime }) => {
    socket.emit('ntp:pong', { clientTime, serverTime: Date.now() });
  });

  socket.on('keepalive', () => socket.emit('keepalive-ack'));

  // Room creation
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
    console.log(`[ROOM] Created ${code}. Total: ${Object.keys(rooms).length}`);
    cb({ ok: true, code, name: rooms[code].name });
  });

  // Room joining
  socket.on('room:join', ({ code }, cb) => {
    if (typeof cb !== 'function') return;
    code = (code || '').toUpperCase().trim();
    const room = rooms[code];

    if (!room) return cb({ ok: false, error: 'Room not found. Check the code.' });
    if (room.listeners.length >= 50) return cb({ ok: false, error: 'Room is full (max 50).' });

    room.listeners.push(socket.id);
    socket.join(code);
    socket.data.code = code;
    socket.data.isHost = false;

    io.to(room.host).emit('room:listener_joined', { id: socket.id, count: room.listeners.length });
    io.to(code).emit('room:count', room.listeners.length);

    console.log(`[ROOM] ${socket.id} joined ${code}. Listeners: ${room.listeners.length}`);
    cb({
      ok: true,
      name: room.name,
      track: room.track,
      state: room.state,
      aiState: room.aiState,
      listenerCount: room.listeners.length,
    });
  });

  // Track management
  socket.on('track:set', ({ streamUrl, title, originalUrl, directUrl }) => {
    const code = socket.data.code;
    const room = rooms[code];
    if (!room || room.host !== socket.id) return;

    room.track = { streamUrl, title, originalUrl, directUrl };
    room.state = { playing: false, position: 0, serverPlayAt: null };
    room.aiState = { genre: null, mood: null, preset: 'flat' };

    socket.to(code).emit('track:set', { streamUrl, title, originalUrl, directUrl });
    console.log(`[TRACK] "${title}" in ${code}`);
  });

  // AI state sharing (host broadcasts AI analysis to listeners)
  socket.on('ai:state', ({ genre, mood, preset, confidence }) => {
    const code = socket.data.code;
    const room = rooms[code];
    if (!room || room.host !== socket.id) return;

    room.aiState = { genre, mood, preset, confidence };
    socket.to(code).emit('ai:state', { genre, mood, preset, confidence });
  });

  // Playback control
  socket.on('audio:play', ({ position, serverPlayAt }) => {
    const code = socket.data.code;
    const room = rooms[code];
    if (!room || room.host !== socket.id) return;
    room.state = { playing: true, position, serverPlayAt };
    socket.to(code).emit('audio:play', { position, serverPlayAt });
  });

  socket.on('audio:pause', ({ position }) => {
    const code = socket.data.code;
    const room = rooms[code];
    if (!room || room.host !== socket.id) return;
    room.state = { playing: false, position, serverPlayAt: null };
    socket.to(code).emit('audio:pause', { position });
  });

  socket.on('audio:seek', ({ position, playing, serverPlayAt }) => {
    const code = socket.data.code;
    const room = rooms[code];
    if (!room || room.host !== socket.id) return;
    room.state = { playing, position, serverPlayAt: playing ? serverPlayAt : null };
    socket.to(code).emit('audio:seek', { position, playing, serverPlayAt });
  });

  // Disconnect handling
  socket.on('disconnect', (reason) => {
    const code = socket.data.code;
    console.log(`[-] ${socket.id} disconnected (${reason})`);
    if (!code || !rooms[code]) return;

    if (socket.data.isHost) {
      io.to(code).emit('room:host_left');
      delete rooms[code];
      console.log(`[ROOM] Host left, deleted ${code}. Total: ${Object.keys(rooms).length}`);
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
  console.log(`🌊 WaveRoom running on port ${PORT}`);
  console.log(`   Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`   Node.js: ${process.version}`);

  try {
    const bin = await ensureYtDlp();
    const { stdout } = await execFileAsync(bin, ['--version'], { timeout: 5000 });
    console.log(`✅ yt-dlp ready: v${stdout.trim()}`);
  } catch (e) {
    console.warn('⚠️  yt-dlp not available at startup:', e.message);
    console.warn('   Will attempt installation on first YouTube request.');
  }
});
