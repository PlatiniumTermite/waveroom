const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST', 'OPTIONS'] },
  transports: ['websocket', 'polling'],
  pingTimeout: 60000,
  pingInterval: 25000,
  upgradeTimeout: 30000,
  allowUpgrades: true,
  perMessageDeflate: false,
  httpCompression: false,
  maxHttpBufferSize: 1e8,
});

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// ─── CORS HEADERS ────────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Range');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ─── YOUTUBE INFO ENDPOINT ────────────────────────────────────────
app.get('/yt-info', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: 'No URL provided' });

  try {
    let ytdl;
    try { ytdl = require('@distube/ytdl-core'); }
    catch(e) { ytdl = require('ytdl-core'); }

    if (!ytdl.validateURL(url)) return res.status(400).json({ error: 'Invalid YouTube URL' });

    const info = await ytdl.getInfo(url, {
      requestOptions: {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept-Language': 'en-US,en;q=0.9',
        }
      }
    });

    const title = info.videoDetails.title;
    const duration = info.videoDetails.lengthSeconds;
    const formats = ytdl.filterFormats(info.formats, 'audioonly');

    // Prefer webm/opus or mp4a formats
    const best = formats
      .filter(f => f.audioBitrate)
      .sort((a, b) => (b.audioBitrate || 0) - (a.audioBitrate || 0))[0];

    if (!best) return res.status(400).json({ error: 'No audio format found for this video' });

    res.json({ title, duration, mimeType: best.mimeType || 'audio/webm' });
  } catch (e) {
    console.error('[YT-INFO] Error:', e.message);
    res.status(500).json({ error: 'YouTube error: ' + e.message });
  }
});

// ─── YOUTUBE STREAM ENDPOINT ─────────────────────────────────────
app.get('/yt-stream', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).send('No URL');

  try {
    let ytdl;
    try { ytdl = require('@distube/ytdl-core'); }
    catch(e) { ytdl = require('ytdl-core'); }

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.setHeader('Cache-Control', 'no-cache');

    const stream = ytdl(url, {
      filter: 'audioonly',
      quality: 'highestaudio',
      highWaterMark: 1 << 25,
      requestOptions: {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        }
      }
    });

    stream.on('error', e => {
      console.error('[YT-STREAM] Error:', e.message);
      if (!res.headersSent) res.status(500).send(e.message);
      else res.end();
    });

    req.on('close', () => stream.destroy());
    stream.pipe(res);
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

// ─── ROOMS ───────────────────────────────────────────────────────
const rooms = {};
const ROOM_TTL = 6 * 60 * 60 * 1000; // 6 hours

function makeCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

// Clean up stale rooms every 30 minutes
setInterval(() => {
  const now = Date.now();
  let cleaned = 0;
  for (const [code, room] of Object.entries(rooms)) {
    if (now - room.createdAt > ROOM_TTL) {
      delete rooms[code];
      cleaned++;
    }
  }
  if (cleaned > 0) console.log(`[GC] Cleaned ${cleaned} stale rooms. Active: ${Object.keys(rooms).length}`);
}, 30 * 60 * 1000);

io.on('connection', (socket) => {
  console.log(`[+] Socket connected: ${socket.id}`);

  // NTP time sync
  socket.on('ntp:ping', ({ clientTime }) => {
    socket.emit('ntp:pong', { clientTime, serverTime: Date.now() });
  });

  socket.on('keepalive', () => {
    socket.emit('keepalive-ack');
  });

  socket.on('room:create', ({ name }, cb) => {
    let code = makeCode();
    let tries = 0;
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
    console.log(`[ROOM] Created ${code} by ${socket.id}. Total: ${Object.keys(rooms).length}`);
    cb({ ok: true, code, name: rooms[code].name });
  });

  socket.on('room:join', ({ code }, cb) => {
    const room = rooms[code];
    console.log(`[ROOM] Join attempt: ${code} | Found: ${!!room}`);
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
    console.log(`[TRACK] Set in ${code}: "${title}"`);
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
    console.log(`[-] Socket disconnected: ${socket.id} | reason: ${reason}`);
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

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🌊 WaveRoom running on port ${PORT}`);
});
