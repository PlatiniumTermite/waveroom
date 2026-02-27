const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  transports: ['websocket', 'polling']
});

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// ─── YOUTUBE INFO ENDPOINT ────────────────────────────────────────
// Returns audio stream URL + title for a YouTube video
app.get('/yt-info', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: 'No URL' });

  try {
    // Lazy-require so server still starts even if ytdl has issues
    const ytdl = require('ytdl-core');
    if (!ytdl.validateURL(url)) return res.status(400).json({ error: 'Invalid YouTube URL' });

    const info = await ytdl.getInfo(url);
    const title = info.videoDetails.title;

    // Get best audio-only format
    const formats = ytdl.filterFormats(info.formats, 'audioonly');
    const best = formats.sort((a, b) => (b.audioBitrate || 0) - (a.audioBitrate || 0))[0];

    if (!best) return res.status(400).json({ error: 'No audio format found' });

    res.json({
      title,
      streamUrl: best.url,
      mimeType: best.mimeType || 'audio/webm',
      duration: info.videoDetails.lengthSeconds
    });
  } catch (e) {
    console.error('YT info error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── YOUTUBE STREAM ENDPOINT ─────────────────────────────────────
// Streams YouTube audio directly through our server
app.get('/yt-stream', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).send('No URL');

  try {
    const ytdl = require('ytdl-core');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Transfer-Encoding', 'chunked');

    const stream = ytdl(url, {
      filter: 'audioonly',
      quality: 'highestaudio',
      highWaterMark: 1 << 25
    });

    stream.on('error', e => { console.error('YT stream error:', e.message); res.end(); });
    stream.pipe(res);
  } catch (e) {
    console.error('YT stream error:', e.message);
    res.status(500).send(e.message);
  }
});

// ─── GENERIC AUDIO PROXY ─────────────────────────────────────────
// Proxies any direct audio URL with CORS headers
app.get('/proxy', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).send('No URL');

  try {
    const fetch = require('node-fetch');
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'audio/*,*/*',
      'Accept-Language': 'en-US,en;q=0.9',
    };
    if (req.headers.range) headers['Range'] = req.headers.range;

    const response = await fetch(url, { headers });
    if (!response.ok) return res.status(response.status).send('Upstream error: ' + response.status);

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', response.headers.get('content-type') || 'audio/mpeg');
    const cl = response.headers.get('content-length');
    const ar = response.headers.get('accept-ranges');
    const cr = response.headers.get('content-range');
    if (cl) res.setHeader('Content-Length', cl);
    if (ar) res.setHeader('Accept-Ranges', ar);
    if (cr) res.setHeader('Content-Range', cr);
    res.status(response.status === 206 ? 206 : 200);
    response.body.pipe(res);
  } catch (e) {
    console.error('Proxy error:', e.message);
    res.status(500).send('Proxy error: ' + e.message);
  }
});

// ─── ROOMS ───────────────────────────────────────────────────────
const rooms = {};

function makeCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

io.on('connection', (socket) => {
  socket.on('ntp:ping', ({ clientTime }) => {
    socket.emit('ntp:pong', { clientTime, serverTime: Date.now() });
  });

  socket.on('keepalive', () => socket.emit('keepalive-ack'));

  socket.on('room:create', ({ name }, cb) => {
    let code = makeCode();
    while (rooms[code]) code = makeCode(); // ensure unique
    rooms[code] = {
      host: socket.id,
      name: name || 'Audio Room',
      listeners: [],
      track: null,
      state: { playing: false, position: 0, serverPlayAt: null }
    };
    socket.join(code);
    socket.data.code = code;
    socket.data.isHost = true;
    console.log(`[+] Room ${code} created. Total: ${Object.keys(rooms).length}`);
    cb({ ok: true, code, name: rooms[code].name });
  });

  socket.on('room:join', ({ code }, cb) => {
    const room = rooms[code];
    console.log(`[?] Join attempt: ${code} | Exists: ${!!room} | Rooms: ${Object.keys(rooms).join(', ')}`);
    if (!room) return cb({ ok: false, error: 'Room not found' });
    room.listeners.push(socket.id);
    socket.join(code);
    socket.data.code = code;
    socket.data.isHost = false;
    io.to(room.host).emit('room:listener_joined', { id: socket.id });
    io.to(code).emit('room:count', room.listeners.length);
    cb({ ok: true, name: room.name, track: room.track, state: room.state });
  });

  socket.on('track:set', ({ url, title, streamUrl }) => {
    const code = socket.data.code;
    const room = rooms[code];
    if (!room || room.host !== socket.id) return;
    room.track = { url, title, streamUrl };
    room.state = { playing: false, position: 0, serverPlayAt: null };
    socket.to(code).emit('track:set', { url, title, streamUrl });
    console.log(`[♪] Track set in ${code}: ${title}`);
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

  socket.on('disconnect', () => {
    const code = socket.data.code;
    if (!code || !rooms[code]) return;
    if (socket.data.isHost) {
      io.to(code).emit('room:host_left');
      delete rooms[code];
      console.log(`[-] Room ${code} deleted. Total: ${Object.keys(rooms).length}`);
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
server.listen(PORT, () => console.log(`WaveRoom on port ${PORT}`));
