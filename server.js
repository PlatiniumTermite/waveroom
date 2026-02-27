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

// ── PROXY ENDPOINT ─────────────────────────────────────────────
// Fetches audio from any URL and streams it back with correct CORS headers
// This bypasses CORS restrictions on audio URLs
app.get('/proxy', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).send('No URL');

  try {
    // Use built-in fetch (Node 18+)
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; WaveRoom/1.0)',
        'Range': req.headers.range || ''
      }
    });

    if (!response.ok) return res.status(response.status).send('Upstream error');

    // Forward relevant headers
    const contentType = response.headers.get('content-type') || 'audio/mpeg';
    const contentLength = response.headers.get('content-length');
    const acceptRanges = response.headers.get('accept-ranges');
    const contentRange = response.headers.get('content-range');

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', contentType);
    if (contentLength) res.setHeader('Content-Length', contentLength);
    if (acceptRanges) res.setHeader('Accept-Ranges', acceptRanges);
    if (contentRange) res.setHeader('Content-Range', contentRange);
    res.status(response.status === 206 ? 206 : 200);

    // Stream the body
    const reader = response.body.getReader();
    const pump = async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) { res.end(); break; }
        if (!res.write(value)) {
          await new Promise(r => res.once('drain', r));
        }
      }
    };
    pump().catch(() => res.end());

  } catch (e) {
    console.error('Proxy error:', e.message);
    res.status(500).send('Proxy failed: ' + e.message);
  }
});

const rooms = {};

function makeCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

io.on('connection', (socket) => {

  // NTP clock sync
  socket.on('ntp:ping', ({ clientTime }) => {
    socket.emit('ntp:pong', { clientTime, serverTime: Date.now() });
  });

  // Keep-alive ping so Render doesn't sleep mid-session
  socket.on('keepalive', () => {
    socket.emit('keepalive-ack');
  });

  socket.on('room:create', ({ name }, cb) => {
    const code = makeCode();
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
    console.log('Room created:', code, '| Total rooms:', Object.keys(rooms).length);
    cb({ ok: true, code, name: rooms[code].name });
  });

  socket.on('room:join', ({ code }, cb) => {
    const room = rooms[code];
    if (!room) {
      console.log('Room not found:', code, '| Available:', Object.keys(rooms));
      return cb({ ok: false, error: 'Room not found' });
    }
    room.listeners.push(socket.id);
    socket.join(code);
    socket.data.code = code;
    socket.data.isHost = false;
    io.to(room.host).emit('room:listener_joined', { id: socket.id });
    io.to(code).emit('room:count', room.listeners.length);
    console.log(socket.id, 'joined room', code);
    cb({ ok: true, name: room.name, track: room.track, state: room.state });
  });

  socket.on('track:set', ({ url, title, proxyUrl }) => {
    const code = socket.data.code;
    const room = rooms[code];
    if (!room || room.host !== socket.id) return;
    room.track = { url, title, proxyUrl };
    room.state = { playing: false, position: 0, serverPlayAt: null };
    socket.to(code).emit('track:set', { url, title, proxyUrl });
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
      console.log('Room deleted:', code);
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
server.listen(PORT, () => console.log(`WaveRoom running on port ${PORT}`));
