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

// Simple health check
app.get('/health', (req, res) => res.send('OK'));

const rooms = {};

function makeCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

io.on('connection', (socket) => {
  console.log('+ connected:', socket.id);

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

  socket.on('offer', ({ to, offer }) => {
    io.to(to).emit('offer', { from: socket.id, offer });
  });

  socket.on('answer', ({ to, answer }) => {
    io.to(to).emit('answer', { from: socket.id, answer });
  });

  socket.on('ice-candidate', ({ to, candidate }) => {
    io.to(to).emit('ice-candidate', { from: socket.id, candidate });
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
      io.to(rooms[code]?.host).emit('listener-left', { id: socket.id });
      io.to(code).emit('listener-count', rooms[code].listeners.length);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`WaveRoom running on port ${PORT}`));
