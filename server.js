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

const rooms = {};

function makeCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

io.on('connection', (socket) => {
  // ── NTP clock sync (do multiple rounds for accuracy)
  socket.on('ntp:ping', ({ id, clientTime }) => {
    socket.emit('ntp:pong', { id, clientTime, serverTime: Date.now() });
  });

  // ── Create room
  socket.on('room:create', ({ name }, cb) => {
    const code = makeCode();
    rooms[code] = {
      host: socket.id,
      name: name || 'Audio Room',
      listeners: [],
      state: { playing: false, startedAt: null, position: 0 }
    };
    socket.join(code);
    socket.data.code = code;
    socket.data.isHost = true;
    console.log('Room created:', code);
    cb({ ok: true, code, name: rooms[code].name });
  });

  // ── Join room
  socket.on('room:join', ({ code }, cb) => {
    const room = rooms[code];
    if (!room) return cb({ ok: false });
    room.listeners.push(socket.id);
    socket.join(code);
    socket.data.code = code;
    socket.data.isHost = false;
    io.to(room.host).emit('room:listener_joined', { id: socket.id });
    io.to(code).emit('room:count', room.listeners.length);
    cb({ ok: true, name: room.name, state: room.state });
  });

  // ── Host → everyone: PLAY at a scheduled server timestamp
  // serverPlayAt = the exact server time (ms) when audio should start
  socket.on('audio:play', ({ position, serverPlayAt }) => {
    const code = socket.data.code;
    const room = rooms[code];
    if (!room || room.host !== socket.id) return;
    room.state = { playing: true, startedAt: serverPlayAt, position };
    socket.to(code).emit('audio:play', { position, serverPlayAt });
  });

  // ── Host → everyone: PAUSE
  socket.on('audio:pause', ({ position }) => {
    const code = socket.data.code;
    const room = rooms[code];
    if (!room || room.host !== socket.id) return;
    room.state = { playing: false, startedAt: null, position };
    socket.to(code).emit('audio:pause', { position });
  });

  // ── Host → everyone: SEEK
  socket.on('audio:seek', ({ position, playing, serverPlayAt }) => {
    const code = socket.data.code;
    const room = rooms[code];
    if (!room || room.host !== socket.id) return;
    room.state = { playing, startedAt: playing ? serverPlayAt : null, position };
    socket.to(code).emit('audio:seek', { position, playing, serverPlayAt });
  });

  // ── Disconnect
  socket.on('disconnect', () => {
    const code = socket.data.code;
    if (!code || !rooms[code]) return;
    if (socket.data.isHost) {
      io.to(code).emit('room:host_left');
      delete rooms[code];
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
