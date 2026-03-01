'use strict';
const express   = require('express');
const http      = require('http');
const { Server } = require('socket.io');
const path      = require('path');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  maxHttpBufferSize: 50e6,
  pingInterval: 10000,
  pingTimeout:  25000,
  transports: ['websocket', 'polling'],
});

app.use(express.static(path.join(__dirname, 'public')));
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Range');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Length,Content-Range,Accept-Ranges');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  next();
});

// ─── ROOMS ───────────────────────────────────────────────────────
const rooms = {};

function makeCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

// Room check endpoint
app.get('/room/:code', (req, res) => {
  const code = (req.params.code || '').toUpperCase().trim();
  const room = rooms[code];
  if (!room) return res.json({ exists: false });
  res.json({ exists: true, name: room.name, listeners: room.listeners.length });
});

app.get('/health', (_req, res) => res.json({ ok: true, uptime: process.uptime(), rooms: Object.keys(rooms).length }));

// ─── SOCKET ──────────────────────────────────────────────────────
io.on('connection', socket => {

  // ── NTP: high-precision clock sync ──────────────────────────────
  // We do this every ping so clockOffset stays accurate over long sessions
  socket.on('ntp:ping', ({ clientTime }) => {
    socket.emit('ntp:pong', { clientTime, serverTime: Date.now() });
  });

  socket.on('keepalive', () => socket.emit('keepalive:ack'));

  // ── CREATE ROOM ──────────────────────────────────────────────────
  socket.on('room:create', ({ name }, cb) => {
    let code = makeCode(), tries = 0;
    while (rooms[code] && tries++ < 100) code = makeCode();
    rooms[code] = {
      host: socket.id,
      name: (name || 'Audio Room').slice(0, 40),
      listeners: [],
      // stream state
      streaming: false,
      mime: 'audio/webm;codecs=opus',
      startedAt: null,        // server Date.now() when stream started
      chunkCount: 0,
    };
    socket.join(code);
    socket.data.code = code;
    socket.data.isHost = true;
    console.log(`[CREATE] ${code} by ${socket.id}`);
    cb({ ok: true, code, name: rooms[code].name });
  });

  // ── JOIN ROOM ────────────────────────────────────────────────────
  socket.on('room:join', ({ code }, cb) => {
    const c = (code || '').toUpperCase().trim();
    const room = rooms[c];
    console.log(`[JOIN] "${c}" | rooms: ${Object.keys(rooms).join(',') || 'none'}`);
    if (!room) return cb({ ok: false, error: 'Room not found' });
    room.listeners.push(socket.id);
    socket.join(c);
    socket.data.code = c;
    socket.data.isHost = false;
    io.to(room.host).emit('listener:joined', { id: socket.id, count: room.listeners.length });
    cb({
      ok: true,
      name: room.name,
      streaming: room.streaming,
      mime: room.mime,
    });
    console.log(`[JOIN] ${socket.id} → ${c}`);
  });

  // ── STREAM EVENTS (host → all listeners) ─────────────────────────

  // Host starts sharing audio
  socket.on('stream:start', ({ mime }) => {
    const code = socket.data.code;
    const room = rooms[code];
    if (!room || room.host !== socket.id) return;
    room.streaming = true;
    room.mime = mime || 'audio/webm;codecs=opus';
    room.startedAt = Date.now();
    room.chunkCount = 0;
    // Tell all listeners to prepare MSE with this mime type
    socket.to(code).emit('stream:start', { mime: room.mime, serverTime: Date.now() });
    console.log(`[STREAM] ${code} started mime=${room.mime}`);
  });

  // Host sends audio chunk — relay to all listeners with server timestamp
  socket.on('stream:chunk', ({ seq, data }) => {
    const code = socket.data.code;
    const room = rooms[code];
    if (!room || room.host !== socket.id) return;
    room.chunkCount++;
    // Attach server timestamp so listeners can calculate exact play position
    socket.to(code).emit('stream:chunk', {
      seq,
      data,
      ts: Date.now(),  // server wall time when this chunk was received
    });
  });

  // Host stops stream
  socket.on('stream:stop', () => {
    const code = socket.data.code;
    const room = rooms[code];
    if (!room || room.host !== socket.id) return;
    room.streaming = false;
    socket.to(code).emit('stream:stop');
    console.log(`[STREAM] ${code} stopped`);
  });

  // ── DISCONNECT ────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    const code = socket.data.code;
    if (!code || !rooms[code]) return;
    const room = rooms[code];
    if (room.host === socket.id) {
      // Host left — notify and delete room
      socket.to(code).emit('host:left');
      delete rooms[code];
      console.log(`[ROOM] ${code} deleted (host left)`);
    } else {
      room.listeners = room.listeners.filter(id => id !== socket.id);
      io.to(room.host).emit('listener:left', { id: socket.id, count: room.listeners.length });
    }
  });
});

// ─── START ────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`WaveRoom v4 on :${PORT}`);
  console.log(`Architecture: Screen-Share → MediaRecorder → Socket.IO → MSE → Web Audio`);
});
