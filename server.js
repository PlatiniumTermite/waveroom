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
  console.log('+ connected:', socket.id);

  // NTP-style clock sync — listener pings server to measure offset
  socket.on('ping-time', ({ clientTime }) => {
    socket.emit('pong-time', {
      serverTime: Date.now(),
      clientSendTime: clientTime
    });
  });

  socket.on('create-room', ({ name }, cb) => {
    const code = makeCode();
    rooms[code] = { host: socket.id, name: name || 'Audio Room', listeners: [] };
    socket.join(code);
    socket.data.code = code;
    socket.data.isHost = true;
    console.log('Room created:', code);
    cb({ ok: true, code, name: rooms[code].name });
  });

  socket.on('join-room', ({ code }, cb) => {
    const room = rooms[code];
    if (!room) return cb({ ok: false, error: 'Room not found' });
    room.listeners.push(socket.id);
    socket.join(code);
    socket.data.code = code;
    socket.data.isHost = false;
    io.to(room.host).emit('listener-joined', { id: socket.id });
    io.to(code).emit('listener-count', room.listeners.length);
    console.log(socket.id, 'joined', code);
    cb({ ok: true, name: room.name });
  });

  // Host -> all listeners: play
  socket.on('play-cmd', ({ currentTime, serverTime }) => {
    const code = socket.data.code;
    if (!code || !rooms[code] || rooms[code].host !== socket.id) return;
    socket.to(code).emit('play-cmd', { currentTime, serverTime: Date.now() });
  });

  // Host -> all listeners: pause
  socket.on('pause-cmd', ({ currentTime }) => {
    const code = socket.data.code;
    if (!code || !rooms[code] || rooms[code].host !== socket.id) return;
    socket.to(code).emit('pause-cmd', { currentTime });
  });

  // Host -> all listeners: seek
  socket.on('seek-cmd', ({ currentTime, playing, serverTime }) => {
    const code = socket.data.code;
    if (!code || !rooms[code] || rooms[code].host !== socket.id) return;
    socket.to(code).emit('seek-cmd', { currentTime, playing, serverTime: Date.now() });
  });

  // Host -> specific listener: current state (when they join mid-session)
  socket.on('sync-state', ({ playing, currentTime, serverNow }) => {
    const code = socket.data.code;
    if (!code || !rooms[code]) return;
    socket.to(code).emit('sync-state', { playing, currentTime, serverNow: Date.now() });
  });

  socket.on('disconnect', () => {
    const code = socket.data.code;
    if (!code || !rooms[code]) return;
    if (socket.data.isHost) {
      io.to(code).emit('host-left');
      delete rooms[code];
      console.log('Room deleted:', code);
    } else {
      rooms[code].listeners = rooms[code].listeners.filter(id => id !== socket.id);
      if (rooms[code]) {
        io.to(rooms[code].host).emit('listener-left', { id: socket.id });
        io.to(code).emit('listener-count', rooms[code].listeners.length);
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`WaveRoom running on port ${PORT}`));
