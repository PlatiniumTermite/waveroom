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

  // NTP clock sync — client pings multiple times for accuracy
  socket.on('ntp:ping', ({ clientTime }) => {
    socket.emit('ntp:pong', { clientTime, serverTime: Date.now() });
  });

  // Host creates room
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
    cb({ ok: true, code, name: rooms[code].name });
  });

  // Listener joins room
  socket.on('room:join', ({ code }, cb) => {
    const room = rooms[code];
    if (!room) return cb({ ok: false });
    room.listeners.push(socket.id);
    socket.join(code);
    socket.data.code = code;
    socket.data.isHost = false;
    io.to(room.host).emit('room:listener_joined', { id: socket.id });
    io.to(code).emit('room:count', room.listeners.length);
    // Send full state so late joiners sync immediately
    cb({ ok: true, name: room.name, track: room.track, state: room.state });
  });

  // Host sets track URL — broadcast to all listeners
  socket.on('track:set', ({ url, title }) => {
    const code = socket.data.code;
    const room = rooms[code];
    if (!room || room.host !== socket.id) return;
    room.track = { url, title };
    room.state = { playing: false, position: 0, serverPlayAt: null };
    socket.to(code).emit('track:set', { url, title });
  });

  // Host plays — precise server timestamp scheduling
  socket.on('audio:play', ({ position, serverPlayAt }) => {
    const code = socket.data.code;
    const room = rooms[code];
    if (!room || room.host !== socket.id) return;
    room.state = { playing: true, position, serverPlayAt };
    socket.to(code).emit('audio:play', { position, serverPlayAt });
  });

  // Host pauses
  socket.on('audio:pause', ({ position }) => {
    const code = socket.data.code;
    const room = rooms[code];
    if (!room || room.host !== socket.id) return;
    room.state = { playing: false, position, serverPlayAt: null };
    socket.to(code).emit('audio:pause', { position });
  });

  // Host seeks
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
server.listen(PORT, () => console.log(`WaveRoom running on port ${PORT}`));;
