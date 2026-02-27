'use strict';

const express  = require('express');
const http     = require('http');
const { Server } = require('socket.io');
const path     = require('path');

const app    = express();
const server = http.createServer(app);

// ──────────────────────────────────────────────────────────────────
// Socket.IO — tuned for reliability on cloud hosts (Render, Railway)
// ──────────────────────────────────────────────────────────────────
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET','POST','OPTIONS'] },
  transports: ['websocket', 'polling'],
  pingInterval: 10000,       // probe every 10 s
  pingTimeout:  25000,       // drop after 25 s silence
  upgradeTimeout: 10000,
  maxHttpBufferSize: 1e6,
  allowEIO3: true,
});

// ──────────────────────────────────────────────────────────────────
// Middleware
// ──────────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Origin,Content-Type,Accept,Range');
  res.setHeader('Access-Control-Expose-Headers','Content-Length,Content-Range,Accept-Ranges');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// ──────────────────────────────────────────────────────────────────
// YouTube helpers — try @distube/ytdl-core first, fall back to ytdl-core
// ──────────────────────────────────────────────────────────────────
function getYtdl() {
  try { return require('@distube/ytdl-core'); } catch (_) {}
  try { return require('ytdl-core'); }           catch (_) {}
  return null;
}

const YT_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) '
    + 'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
};

// GET /yt-info?url=… → { title, duration }
app.get('/yt-info', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: 'No URL' });
  const ytdl = getYtdl();
  if (!ytdl) return res.status(500).json({ error: 'ytdl not installed' });

  try {
    if (!ytdl.validateURL(url)) return res.status(400).json({ error: 'Invalid YouTube URL' });

    const info = await ytdl.getInfo(url, { requestOptions: { headers: YT_HEADERS } });
    const fmts = ytdl.filterFormats(info.formats, 'audioonly')
      .filter(f => f.audioBitrate)
      .sort((a, b) => (b.audioBitrate||0) - (a.audioBitrate||0));

    if (!fmts.length) return res.status(400).json({ error: 'No audio format found' });

    return res.json({
      title:    info.videoDetails.title,
      duration: Number(info.videoDetails.lengthSeconds),
    });
  } catch (e) {
    console.error('[YT-INFO]', e.message);
    return res.status(500).json({ error: e.message });
  }
});

// GET /yt-stream?url=… — streams audio through server (fixes CORS + range issues)
app.get('/yt-stream', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).end('No URL');
  const ytdl = getYtdl();
  if (!ytdl) return res.status(500).end('ytdl not installed');

  try {
    if (!ytdl.validateURL(url)) return res.status(400).end('Invalid URL');

    // Need full info for best audio format
    const info = await ytdl.getInfo(url, { requestOptions: { headers: YT_HEADERS } });
    const fmts = ytdl.filterFormats(info.formats, 'audioonly')
      .filter(f => f.audioBitrate)
      .sort((a, b) => (b.audioBitrate||0) - (a.audioBitrate||0));

    if (!fmts.length) return res.status(400).end('No audio format');
    const best = fmts[0];

    // Prefer mp4a (AAC) because browsers decode it without needing a codec
    const aac = fmts.find(f => f.mimeType && f.mimeType.includes('mp4a'));
    const chosen = aac || best;

    const mime = (chosen.mimeType || 'audio/mp4').split(';')[0];

    res.setHeader('Content-Type', mime);
    res.setHeader('Accept-Ranges', 'none');           // we don't support range on stream
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Content-Type-Options', 'nosniff');

    const stream = ytdl.downloadFromInfo(info, {
      format: chosen,
      highWaterMark: 1 << 24, // 16 MB buffer
      requestOptions: { headers: YT_HEADERS },
    });

    stream.on('error', err => {
      console.error('[YT-STREAM]', err.message);
      if (!res.headersSent) res.status(500).end(err.message);
      else res.destroy();
    });

    req.on('close', () => stream.destroy());
    stream.pipe(res);

  } catch (e) {
    console.error('[YT-STREAM] fatal', e.message);
    if (!res.headersSent) res.status(500).end(e.message);
  }
});

// GET /proxy?url=… — generic CORS proxy for direct audio URLs, supports Range
app.get('/proxy', async (req, res) => {
  const rawUrl = req.query.url;
  if (!rawUrl) return res.status(400).end('No URL');

  // Basic SSRF protection — block private/localhost addresses
  try {
    const u = new URL(rawUrl);
    if (/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(u.hostname))
      return res.status(403).end('Forbidden');
  } catch (_) {
    return res.status(400).end('Invalid URL');
  }

  try {
    const fetch = require('node-fetch');
    const upHeaders = {
      'User-Agent': 'Mozilla/5.0 (compatible; AudioProxy/1.0)',
      'Accept':     'audio/*,*/*;q=0.8',
    };
    if (req.headers.range) upHeaders['Range'] = req.headers.range;

    const up = await fetch(rawUrl, { headers: upHeaders, timeout: 15000 });
    if (!up.ok && up.status !== 206) return res.status(up.status).end(`Upstream ${up.status}`);

    const ct = up.headers.get('content-type') || 'audio/mpeg';
    const cl = up.headers.get('content-length');
    const cr = up.headers.get('content-range');
    const ar = up.headers.get('accept-ranges');

    res.status(up.status === 206 ? 206 : 200);
    res.setHeader('Content-Type', ct);
    res.setHeader('Accept-Ranges', ar || 'bytes');
    if (cl) res.setHeader('Content-Length', cl);
    if (cr) res.setHeader('Content-Range', cr);

    up.body.pipe(res);
    req.on('close', () => up.body.destroy && up.body.destroy());
  } catch (e) {
    console.error('[PROXY]', e.message);
    if (!res.headersSent) res.status(500).end('Proxy error: ' + e.message);
  }
});

// ──────────────────────────────────────────────────────────────────
// Room state
// ──────────────────────────────────────────────────────────────────
const rooms = new Map(); // code → Room

function makeCode() {
  const alpha = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 6; i++) s += alpha[Math.random() * alpha.length | 0];
  return s;
}

function uniqueCode() {
  let c, tries = 0;
  do { c = makeCode(); } while (rooms.has(c) && ++tries < 200);
  return c;
}

// Prune rooms idle > 8 h
setInterval(() => {
  const limit = Date.now() - 8 * 3600 * 1000;
  for (const [code, room] of rooms)
    if (room.createdAt < limit) { rooms.delete(code); console.log('[GC] pruned', code); }
}, 30 * 60 * 1000);

// ──────────────────────────────────────────────────────────────────
// Socket.IO handlers
// ──────────────────────────────────────────────────────────────────
io.on('connection', socket => {
  console.log('[+]', socket.id, socket.handshake.address);

  // ── NTP sub-millisecond clock sync ──────────────────────────────
  // We record serverTime with high-res timer so the offset calculation
  // on the client is as accurate as possible.
  socket.on('ntp:ping', ({ id, t0 }) => {
    socket.emit('ntp:pong', { id, t0, t1: Date.now() });
  });

  socket.on('keepalive', () => socket.emit('keepalive-ack'));

  // ── Create room ────────────────────────────────────────────────
  socket.on('room:create', ({ name }, cb) => {
    if (typeof cb !== 'function') return;
    const code = uniqueCode();
    rooms.set(code, {
      host:      socket.id,
      name:      (name || 'Audio Room').slice(0, 50),
      listeners: new Set(),
      track:     null,
      // state persists so late-joiners can sync
      state:     { playing: false, position: 0, serverPlayAt: null, updatedAt: Date.now() },
      createdAt: Date.now(),
    });
    socket.join(code);
    socket.data.code   = code;
    socket.data.isHost = true;
    console.log('[CREATE]', code, 'by', socket.id);
    cb({ ok: true, code, name: rooms.get(code).name });
  });

  // ── Join room ──────────────────────────────────────────────────
  socket.on('room:join', ({ code }, cb) => {
    if (typeof cb !== 'function') return;
    const room = rooms.get(code);
    if (!room) return cb({ ok: false, error: 'Room not found' });

    room.listeners.add(socket.id);
    socket.join(code);
    socket.data.code   = code;
    socket.data.isHost = false;

    // Tell host a listener joined
    io.to(room.host).emit('room:listener_joined', { id: socket.id });
    io.to(code).emit('room:count', room.listeners.size);

    // Send current state — client will compute correct position from serverPlayAt
    cb({ ok: true, name: room.name, track: room.track, state: room.state });
    console.log('[JOIN]', code, socket.id);
  });

  // ── Track loaded by host ───────────────────────────────────────
  socket.on('track:set', ({ streamUrl, title, originalUrl }) => {
    const room = rooms.get(socket.data.code);
    if (!room || room.host !== socket.id) return;
    room.track = { streamUrl, title, originalUrl };
    room.state = { playing: false, position: 0, serverPlayAt: null, updatedAt: Date.now() };
    socket.to(socket.data.code).emit('track:set', { streamUrl, title });
    console.log('[TRACK]', socket.data.code, title);
  });

  // ── Play ───────────────────────────────────────────────────────
  socket.on('audio:play', ({ position, serverPlayAt }) => {
    const room = rooms.get(socket.data.code);
    if (!room || room.host !== socket.id) return;
    room.state = { playing: true, position, serverPlayAt, updatedAt: Date.now() };
    socket.to(socket.data.code).emit('audio:play', { position, serverPlayAt });
  });

  // ── Pause ──────────────────────────────────────────────────────
  socket.on('audio:pause', ({ position }) => {
    const room = rooms.get(socket.data.code);
    if (!room || room.host !== socket.id) return;
    room.state = { playing: false, position, serverPlayAt: null, updatedAt: Date.now() };
    socket.to(socket.data.code).emit('audio:pause', { position });
  });

  // ── Seek ───────────────────────────────────────────────────────
  socket.on('audio:seek', ({ position, playing, serverPlayAt }) => {
    const room = rooms.get(socket.data.code);
    if (!room || room.host !== socket.id) return;
    room.state = { playing, position, serverPlayAt: playing ? serverPlayAt : null, updatedAt: Date.now() };
    socket.to(socket.data.code).emit('audio:seek', { position, playing, serverPlayAt });
  });

  // ── Disconnect ─────────────────────────────────────────────────
  socket.on('disconnect', reason => {
    const code = socket.data.code;
    if (!code) return;
    const room = rooms.get(code);
    if (!room) return;

    if (socket.data.isHost) {
      io.to(code).emit('room:host_left');
      rooms.delete(code);
      console.log('[DEL]', code, reason);
    } else {
      room.listeners.delete(socket.id);
      io.to(room.host).emit('room:listener_left', { id: socket.id });
      io.to(code).emit('room:count', room.listeners.size);
    }
  });
});

// ──────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`🌊 WaveRoom :${PORT}`));
