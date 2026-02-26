const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  maxHttpBufferSize: 50e6 // 50MB for audio chunks
});

app.use(express.static(path.join(__dirname, 'public')));

// rooms: { roomId: { host: socketId, state: {playing, currentTime, trackName, startedAt}, listeners: Set } }
const rooms = {};

function generateRoomCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

io.on('connection', (socket) => {
  console.log('Connected:', socket.id);

  // Host creates room
  socket.on('create-room', (trackName) => {
    const roomId = generateRoomCode();
    rooms[roomId] = {
      host: socket.id,
      trackName: trackName || 'Unknown Track',
      state: { playing: false, currentTime: 0, startedAt: null },
      listeners: new Set()
    };
    socket.join(roomId);
    socket.roomId = roomId;
    socket.isHost = true;
    socket.emit('room-created', { roomId });
    console.log(`Room ${roomId} created by ${socket.id}`);
  });

  // Listener joins room
  socket.on('join-room', (roomId) => {
    const room = rooms[roomId];
    if (!room) {
      socket.emit('error', 'Room not found');
      return;
    }
    socket.join(roomId);
    socket.roomId = roomId;
    socket.isHost = false;
    room.listeners.add(socket.id);

    // Send current state to new listener
    const now = Date.now();
    let syncTime = room.state.currentTime;
    if (room.state.playing && room.state.startedAt) {
      syncTime = room.state.currentTime + (now - room.state.startedAt) / 1000;
    }

    socket.emit('room-joined', {
      roomId,
      trackName: room.trackName,
      state: { ...room.state, currentTime: syncTime },
      listenerCount: room.listeners.size
    });

    // Tell host: new listener joined, send audio chunk
    io.to(room.host).emit('listener-joined', { listenerId: socket.id });

    // Update listener count for everyone
    io.to(roomId).emit('listener-count', room.listeners.size);
    console.log(`${socket.id} joined room ${roomId}`);
  });

  // Host sends audio chunk to a specific listener
  socket.on('audio-chunk', ({ listenerId, chunk }) => {
    io.to(listenerId).emit('audio-chunk', chunk);
  });

  // Host broadcasts play/pause/seek
  socket.on('playback-event', (event) => {
    const roomId = socket.roomId;
    const room = rooms[roomId];
    if (!room || room.host !== socket.id) return;

    const now = Date.now();
    if (event.type === 'play') {
      room.state.playing = true;
      room.state.currentTime = event.currentTime;
      room.state.startedAt = now;
    } else if (event.type === 'pause') {
      room.state.playing = false;
      room.state.currentTime = event.currentTime;
      room.state.startedAt = null;
    } else if (event.type === 'seek') {
      room.state.currentTime = event.currentTime;
      room.state.startedAt = room.state.playing ? now : null;
    }

    // Broadcast to all listeners with server timestamp for sync
    socket.to(roomId).emit('playback-event', { ...event, serverTime: now });
  });

  // Host updates track name
  socket.on('track-name', (name) => {
    const room = rooms[socket.roomId];
    if (room && room.host === socket.id) {
      room.trackName = name;
      io.to(socket.roomId).emit('track-name', name);
    }
  });

  // WebRTC signaling
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
    const roomId = socket.roomId;
    const room = rooms[roomId];
    if (!room) return;

    if (room.host === socket.id) {
      io.to(roomId).emit('host-left');
      delete rooms[roomId];
    } else {
      room.listeners.delete(socket.id);
      io.to(roomId).emit('listener-count', room.listeners.size);
    }
    console.log(`Disconnected: ${socket.id} from room ${roomId}`);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`AudioSync server running on port ${PORT}`));
