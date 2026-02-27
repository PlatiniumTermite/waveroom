const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { execFile, spawn } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

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

// ─── HEALTH CHECK ────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

// ─── CORS ─────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Range');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ─── yt-dlp HELPERS ──────────────────────────────────────────────
// yt-dlp is pre-installed on Render's Linux environment.
// Falls back to searching PATH, then common install locations.
function getYtDlpBin() {
  const candidates = [
    'yt-dlp',
    '/usr/local/bin/yt-dlp',
    '/usr/bin/yt-dlp',
    path.join(process.env.HOME || '/root', '.local/bin/yt-dlp'),
  ];
  // Return first found; we'll try them in order at runtime
  return candidates;
}

// Attempt to find working yt-dlp binary
let _ytdlpBin = null;
async function findYtDlp() {
  if (_ytdlpBin) return _ytdlpBin;
  for (const bin of getYtDlpBin()) {
    try {
      await execFileAsync(bin, ['--version'], { timeout: 5000 });
      _ytdlpBin = bin;
      console.log('[yt-dlp] Found at:', bin);
      return bin;
    } catch (e) { /* try next */ }
  }
  return null;
}

// Install yt-dlp if missing (Render has pip/curl available)
async function ensureYtDlp() {
  const bin = await findYtDlp();
  if (bin) return bin;

  console.log('[yt-dlp] Not found — attempting install...');
  try {
    // Try pip install
    await execFileAsync('pip3', ['install', '--quiet', '--user', 'yt-dlp'], { timeout: 60000 });
    _ytdlpBin = null; // reset cache
    const found = await findYtDlp();
    if (found) { console.log('[yt-dlp] Installed via pip3'); return found; }
  } catch (e) { console.warn('[yt-dlp] pip3 install failed:', e.message); }

  try {
    // Try curl download
    const dest = '/usr/local/bin/yt-dlp';
    await execFileAsync('curl', ['-sL', 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp', '-o', dest], { timeout: 30000 });
    await execFileAsync('chmod', ['+x', dest], { timeout: 5000 });
    _ytdlpBin = dest;
    console.log('[yt-dlp] Installed via curl to', dest);
    return dest;
  } catch (e) { console.warn('[yt-dlp] curl install failed:', e.message); }

  throw new Error('yt-dlp not available. Cannot process YouTube URLs.');
}

// ─── YOUTUBE INFO ─────────────────────────────────────────────────
app.get('/yt-info', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: 'No URL provided' });

  if (!isYouTubeUrl(url)) return res.status(400).json({ error: 'Not a valid YouTube URL' });

  try {
    const bin = await ensureYtDlp();

    // Get JSON metadata from yt-dlp
    const args = [
      '--no-playlist',
      '--skip-download',
      '--print-json',
      '--no-warnings',
      '--quiet',
      '-f', 'bestaudio[ext=m4a]/bestaudio/best',
      url
    ];

    const { stdout } = await execFileAsync(bin, args, { timeout: 30000, maxBuffer: 10 * 1024 * 1024 });
    const info = JSON.parse(stdout.trim());

    res.json({
      title: info.title || 'Unknown',
      duration: info.duration || 0,
      mimeType: 'audio/mp4',
    });
  } catch (e) {
    console.error('[YT-INFO] Error:', e.message);
    // Provide helpful error
    let msg = e.message;
    if (msg.includes('Sign in') || msg.includes('bot')) msg = 'YouTube blocked this request. Try a different video.';
    else if (msg.includes('not available')) msg = 'This video is not available or region-locked.';
    else if (msg.includes('Private')) msg = 'This video is private.';
    res.status(500).json({ error: msg });
  }
});

// ─── YOUTUBE STREAM ───────────────────────────────────────────────
// Streams audio by piping yt-dlp stdout directly to the response.
// This avoids any temp file and works great on Render's ephemeral FS.
app.get('/yt-stream', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).send('No URL');
  if (!isYouTubeUrl(url)) return res.status(400).send('Not a YouTube URL');

  try {
    const bin = await ensureYtDlp();

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'audio/mp4');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Content-Type-Options', 'nosniff');

    const args = [
      '--no-playlist',
      '--no-warnings',
      '--quiet',
      '-f', 'bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio/best',
      '-o', '-',   // output to stdout
      url
    ];

    console.log('[YT-STREAM] Starting stream for:', url.slice(0, 60));
    const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    proc.stdout.pipe(res);

    let stderrBuf = '';
    proc.stderr.on('data', d => { stderrBuf += d.toString(); });

    proc.on('error', e => {
      console.error('[YT-STREAM] spawn error:', e.message);
      if (!res.headersSent) res.status(500).send(e.message);
      else res.end();
    });

    proc.on('close', code => {
      if (code !== 0 && stderrBuf) console.warn('[YT-STREAM] exit', code, stderrBuf.slice(0, 300));
      res.end();
    });

    req.on('close', () => {
      proc.kill('SIGTERM');
    });

  } catch (e) {
    console.error('[YT-STREAM] Fatal:', e.message);
    if (!res.headersSent) res.status(500).send(e.message);
  }
});

// ─── GENERIC AUDIO PROXY ─────────────────────────────────────────
app.get('/proxy', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).send('No URL');

  try {
    const fetch = require('node-fetch');
    const reqHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'audio/*,*/*;q=0.9',
      'Accept-Language': 'en-US,en;q=0.9',
    };
    if (req.headers.range) reqHeaders['Range'] = req.headers.range;

    const upstream = await fetch(url, { headers: reqHeaders });
    if (!upstream.ok && upstream.status !== 206) {
      return res.status(upstream.status).send('Upstream error: ' + upstream.status);
    }

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'audio/mpeg');
    res.setHeader('Accept-Ranges', 'bytes');
    const cl = upstream.headers.get('content-length');
    const cr = upstream.headers.get('content-range');
    const ar = upstream.headers.get('accept-ranges');
    if (cl) res.setHeader('Content-Length', cl);
    if (cr) res.setHeader('Content-Range', cr);
    if (ar) res.setHeader('Accept-Ranges', ar);
    res.status(upstream.status === 206 ? 206 : 200);
    upstream.body.pipe(res);
  } catch (e) {
    console.error('[PROXY] Error:', e.message);
    if (!res.headersSent) res.status(500).send('Proxy error: ' + e.message);
  }
});

// ─── HELPERS ─────────────────────────────────────────────────────
function isYouTubeUrl(url) {
  try {
    const u = new URL(url);
    return ['youtube.com', 'www.youtube.com', 'youtu.be', 'm.youtube.com', 'music.youtube.com']
      .includes(u.hostname);
  } catch { return false; }
}

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
    if (now - room.createdAt > ROOM_TTL) { delete rooms[code]; cleaned++; }
  }
  if (cleaned > 0) console.log(`[GC] Cleaned ${cleaned} stale rooms. Active: ${Object.keys(rooms).length}`);
}, 30 * 60 * 1000);

io.on('connection', (socket) => {
  console.log(`[+] Socket: ${socket.id}`);

  socket.on('ntp:ping', ({ clientTime }) => {
    socket.emit('ntp:pong', { clientTime, serverTime: Date.now() });
  });

  socket.on('keepalive', () => socket.emit('keepalive-ack'));

  socket.on('room:create', ({ name }, cb) => {
    let code = makeCode(), tries = 0;
    while (rooms[code] && tries++ < 100) code = makeCode();
    rooms[code] = {
      host: socket.id,
      name: name || 'Audio Room',
      listeners: [],
      track: null,
      state: { playing: false, position: 0, serverPlayAt: null },
      createdAt: Date.now(),
    };
    socket.join(code);
    socket.data.code = code;
    socket.data.isHost = true;
    console.log(`[ROOM] Created ${code}. Total: ${Object.keys(rooms).length}`);
    cb({ ok: true, code, name: rooms[code].name });
  });

  socket.on('room:join', ({ code }, cb) => {
    const room = rooms[code];
    console.log(`[ROOM] Join: ${code} | Found: ${!!room}`);
    if (!room) return cb({ ok: false, error: 'Room not found' });
    room.listeners.push(socket.id);
    socket.join(code);
    socket.data.code = code;
    socket.data.isHost = false;
    io.to(room.host).emit('room:listener_joined', { id: socket.id });
    io.to(code).emit('room:count', room.listeners.length);
    cb({ ok: true, name: room.name, track: room.track, state: room.state });
  });

  socket.on('track:set', ({ streamUrl, title, originalUrl }) => {
    const code = socket.data.code;
    const room = rooms[code];
    if (!room || room.host !== socket.id) return;
    room.track = { streamUrl, title, originalUrl };
    room.state = { playing: false, position: 0, serverPlayAt: null };
    socket.to(code).emit('track:set', { streamUrl, title, originalUrl });
    console.log(`[TRACK] "${title}" in ${code}`);
  });

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

  socket.on('disconnect', (reason) => {
    const code = socket.data.code;
    console.log(`[-] Disconnect: ${socket.id} (${reason})`);
    if (!code || !rooms[code]) return;
    if (socket.data.isHost) {
      io.to(code).emit('room:host_left');
      delete rooms[code];
      console.log(`[ROOM] Deleted ${code}. Total: ${Object.keys(rooms).length}`);
    } else {
      rooms[code].listeners = rooms[code].listeners.filter(id => id !== socket.id);
      if (rooms[code]) {
        io.to(rooms[code].host).emit('room:listener_left', { id: socket.id });
        io.to(code).emit('room:count', rooms[code].listeners.length);
      }
    }
  });
});

// ─── STARTUP: pre-check yt-dlp ───────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', async () => {
  console.log(`🌊 WaveRoom running on port ${PORT}`);
  try {
    const bin = await ensureYtDlp();
    const { stdout } = await execFileAsync(bin, ['--version'], { timeout: 5000 });
    console.log(`✅ yt-dlp ready: v${stdout.trim()}`);
  } catch (e) {
    console.warn('⚠️  yt-dlp not available at startup:', e.message);
    console.warn('   YouTube streaming will be unavailable until yt-dlp is installed.');
  }
});
