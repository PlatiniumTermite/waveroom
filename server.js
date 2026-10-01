'use strict';
const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const path       = require('path');
const { randomBytes } = require('crypto');
const { performance } = require('node:perf_hooks');
const { youtubeId, positionAt, validPosition, scheduleDelay } = require('./public/sync-model');

function createWaveRoom({ resolveYoutube = require('./youtube-audio').resolveYoutube } = {}) {

const clockOrigin = Date.now()-performance.now();
const serverNow = () => clockOrigin+performance.now();
const app    = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: '*', methods: ['GET','POST'] },
  transports: ['polling', 'websocket'],
  pingTimeout:  60000,
  pingInterval: 20000,
  allowEIO3: true,
  maxHttpBufferSize: 2e6
});

app.use(express.static(path.join(__dirname, 'public')));

// ── Health ────────────────────────────────────────────────────────
app.get('/health', (_, res) =>
  res.json({ ok: true, rooms: Object.keys(rooms).length, ts: serverNow() })
);

// Uploaded files stay in memory for the lifetime of their room.
app.post('/upload', (req, res, next) => {
  const room = rooms[req.query.code];
  if (!room || req.get('X-Room-Host') !== room.hostToken) return res.status(403).json({ error: 'Host authorization required' });
  room.sourceRequest = (room.sourceRequest || 0) + 1;
  req.uploadRoom = room;
  next();
}, express.raw({ type: () => true, limit: '25mb' }), (req, res) => {
  const room = req.uploadRoom;
  if (rooms[req.query.code] !== room) return res.status(410).json({ error: 'Room ended during upload' });
  if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'Empty file' });
  const used = Object.values(rooms).reduce((total, value) => total + (value.media?.buffer.length || 0), 0);
  if (used - (room.media?.buffer.length || 0) + req.body.length > 100 * 1024 * 1024) {
    return res.status(503).json({ error: 'Upload storage is full. Try a smaller file.' });
  }
  const type = req.get('Content-Type') || 'application/octet-stream';
  if (!type.startsWith('audio/') && type !== 'application/octet-stream') return res.status(415).json({ error: 'Choose an audio file' });
  const id = randomBytes(24).toString('hex');
  room.media = { id, buffer: req.body, type };
  res.json({ streamUrl: '/media/' + id });
});
// Resolve one shared audio file; devices never download separate YouTube streams.
let youtubeJobs = 0;
app.post('/youtube', express.json({ limit: '4kb' }), async (req, res) => {
  const room = rooms[req.query.code];
  if (!room || req.get('X-Room-Host') !== room.hostToken) return res.status(403).json({ error: 'Host authorization required' });
  const videoId = youtubeId(req.body?.url);
  if (!videoId) return res.status(400).json({ error: 'Enter a YouTube video link' });
  if (room.youtubeBusy || youtubeJobs >= 2) return res.status(429).json({ error: 'Audio preparation is busy. Try again shortly.' });
  const request = room.sourceRequest = (room.sourceRequest || 0) + 1;
  room.youtubeBusy = true; youtubeJobs++;
  try {
    const media = await resolveYoutube(videoId);
    if (rooms[req.query.code] !== room || room.sourceRequest !== request) {
      return res.status(409).json({ error: 'Room or audio source changed during preparation' });
    }
    const used = Object.values(rooms).reduce((total, item) => total + (item.media?.buffer.length || 0), 0);
    if (!Buffer.isBuffer(media.buffer) || !media.buffer.length || media.buffer.length > 25 * 1024 * 1024 ||
      used - (room.media?.buffer.length || 0) + media.buffer.length > 100 * 1024 * 1024) {
      return res.status(503).json({ error: 'Room audio storage limit reached' });
    }
    const id = randomBytes(24).toString('hex');
    room.media = { ...media, id };
    res.json({ streamUrl: '/media/' + id, title: media.title });
  } catch (error) {
    res.status(502).json({ error: error.message });
  } finally { room.youtubeBusy = false; youtubeJobs--; }
});
app.get('/media/:id', (req, res) => {
  const media = Object.values(rooms).find(room => room.media?.id === req.params.id)?.media;
  if (!media) return res.sendStatus(404);
  const size = media.buffer.length;
  res.set({ 'Content-Type': media.type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  if (!req.headers.range) return res.send(media.buffer);
  const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
  if (!match || (!match[1] && !match[2])) return res.status(416).set('Content-Range', 'bytes */' + size).end();
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  const end = match[1] && match[2] ? Math.min(size - 1, Number(match[2])) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) {
    return res.status(416).set('Content-Range', 'bytes */' + size).end();
  }
  res.status(206).set('Content-Range', `bytes ${start}-${end}/${size}`).send(media.buffer.subarray(start, end + 1));
});
app.use((error, req, res, next) => {
  if (error.type === 'entity.too.large') return res.status(413).json({ error: 'Audio files must be 25 MB or smaller' });
  next(error);
});

// ── Generic audio proxy (for direct MP3/WAV/OGG URLs) ────────────
app.get('/proxy', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).send('No URL');
  try {
    const fetch = require('node-fetch');
    const hdrs  = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122',
      'Accept': 'audio/*,*/*',
      'Accept-Encoding': 'identity',
    };
    if (req.headers.range) hdrs['Range'] = req.headers.range;
    const up = await fetch(url, { headers: hdrs });
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', up.headers.get('content-type') || 'audio/mpeg');
    const cl = up.headers.get('content-length');
    const ar = up.headers.get('accept-ranges');
    const cr = up.headers.get('content-range');
    if (cl) res.setHeader('Content-Length', cl);
    if (ar) res.setHeader('Accept-Ranges', ar);
    if (cr) res.setHeader('Content-Range', cr);
    res.status(up.status);
    res.on('close', () => { try { up.body.destroy(); } catch(_){} });
    up.body.pipe(res);
  } catch(e) {
    console.error('[PROXY]', e.message);
    if (!res.headersSent) res.status(500).send('Proxy error: ' + e.message);
  }
});

// ── WebRTC signalling (for screen audio capture mode) ────────────
// Host captures screen/tab audio → sends WebRTC offer to each listener
io.on('connection', socket => {
  // Invalid socket payloads must not crash the room server.
  socket.use((packet, next) => {
    if (['ntp:ping', 'room:create', 'room:join', 'track:set', 'device:status', 'playback:command', 'webrtc:offer', 'webrtc:answer', 'webrtc:ice'].includes(packet[0]) &&
      (!packet[1] || typeof packet[1] !== 'object' || Array.isArray(packet[1]))) packet[1] = {};
    next();
  });

  function updateTiming(data) {
    if(Number.isFinite(data?.rtt) && data.rtt>=0 && data.rtt<=10000 &&
      Number.isFinite(data?.compensationMs) && data.compensationMs>=0 && data.compensationMs<=2000){
      socket.data.timing={rtt:data.rtt,compensationMs:data.compensationMs};
    }
  }
  socket.on('ntp:ping', (data = {}) => {
    const t1=serverNow();updateTiming(data);
    if(Number.isFinite(data.t0) && Number.isSafeInteger(data.groupId) && [0,1].includes(data.index)){
      socket.emit('ntp:pong',{t0:data.t0,t1,t2:serverNow(),groupId:data.groupId,index:data.index});
    }else if(Number.isFinite(data.clientTime)){
      socket.emit('ntp:pong',{clientTime:data.clientTime,serverTime:serverNow()});
    }
  });
  socket.on('keepalive', () => socket.emit('keepalive-ack'));

  function snapshot(room) {
    return { track: room.track, state: room.state, devices: room.devices, serverTime: serverNow() };
  }
  function publish(room, code) { io.to(code).emit('room:state', snapshot(room)); }
  function allReady(room) {
    return io.sockets.sockets.has(room.host) && Object.values(room.devices).length > 0 &&
      Object.values(room.devices).every(device => device.ready);
  }
  function resumeIfReady(room, code) {
    if (!room.state.waiting || !allReady(room)) return;
    for (const device of Object.values(room.devices)) device.participating = true;
    room.state = { playing: true, waiting: false, position: room.state.position,
      serverPlayAt: serverNow() + scheduleDelay(Object.keys(room.devices).map(id=>io.sockets.sockets.get(id)?.data.timing)), revision: room.state.revision + 1 };
    publish(room, code);
  }
  function waitTogether(room, code, position = positionAt(room.state, serverNow())) {
    room.state = { playing: false, waiting: true, position,
      serverPlayAt: null, revision: room.state.revision + 1 };
    for (const device of Object.values(room.devices)) { device.ready = false; device.status = 'loading'; }
    publish(room, code);
  }
  function hostRoom() {
    const room = rooms[socket.data.code];
    return room && room.host === socket.id ? room : null;
  }
  function reply(cb, data) { if (typeof cb === 'function') cb(data); }

  socket.on('room:create', ({ name } = {}, cb) => {
    if (socket.data.code) return reply(cb, { ok: false, error: 'Already in a room' });
    let code = genCode();
    while (rooms[code]) code = genCode();
    const room = rooms[code] = {
      host: socket.id, hostToken: randomBytes(24).toString('hex'),
      name: typeof name === 'string' ? name.slice(0, 80) : 'Audio Room',
      listeners: [], devices: {}, track: null,
      state: { playing: false, waiting: false, position: 0, serverPlayAt: null, revision: 0 }
    };
    socket.join(code);
    socket.data.code = code;
    socket.data.isHost = true;
    reply(cb, { ok: true, code, name: room.name, hostToken: room.hostToken, ...snapshot(room) });
  });

  socket.on('room:join', ({ code, hostToken } = {}, cb) => {
    if (typeof code !== 'string') return reply(cb, { ok: false, error: 'Invalid room code' });
    code = code.toUpperCase();
    const room = rooms[code];
    if (!room) return reply(cb, { ok: false, error: 'Room not found' });
    if (socket.data.code) return reply(cb, { ok: false, error: 'Already in a room' });
    if (hostToken) {
      if (hostToken !== room.hostToken || io.sockets.sockets.has(room.host)) {
        return reply(cb, { ok: false, error: 'Cannot resume host session' });
      }
      clearTimeout(room.closeTimer);
      room.host = socket.id;
      socket.data.isHost = true;
    } else {
      room.listeners.push(socket.id);
      socket.data.isHost = false;
      io.to(room.host).emit('room:listener_joined', { id: socket.id });
    }
    socket.join(code);
    socket.data.code = code;
    if (room.track && !room.track.isScreenShare) room.devices[socket.id] = { ready: false, status: 'loading' };
    io.to(code).emit('room:count', room.listeners.length);
    reply(cb, { ok: true, name: room.name, listeners: room.listeners, ...snapshot(room) });
    publish(room, code);
  });

  socket.on('track:set', (data = {}, cb) => {
    const room = hostRoom();
    if (!room) return reply(cb, { ok: false, error: 'Only the host can load a track' });
    let track;
    if (data.kind === 'youtube') {
      const videoId = youtubeId(data.originalUrl);
      if (!videoId) return reply(cb, { ok: false, error: 'Invalid YouTube link' });
      track = { kind: 'youtube', videoId, title: 'YouTube · ' + videoId, originalUrl: data.originalUrl.slice(0, 2048) };
    } else if (data.isScreenShare) {
      track = { kind: 'screen', isScreenShare: true, title: 'Screen Audio', streamUrl: '__screen__' };
    } else if (typeof data.streamUrl === 'string' && data.streamUrl.length <= 4096 &&
      (data.streamUrl.startsWith('/proxy?url=') || data.streamUrl === '/media/' + room.media?.id)) {
      track = { kind: 'audio', streamUrl: data.streamUrl, title: String(data.title || 'Audio').slice(0, 200) };
    } else return reply(cb, { ok: false, error: 'Invalid audio source' });
    room.sourceRequest = (room.sourceRequest || 0) + 1;
    track.id = randomBytes(12).toString('hex');
    room.track = track;
    room.devices = Object.fromEntries([room.host, ...room.listeners].map(id => [id, { ready: false, status: 'loading' }]));
    room.state = { playing: false, waiting: data.autoplay === true && !track.isScreenShare,
      position: 0, serverPlayAt: null, revision: room.state.revision + 1 };
    io.to(socket.data.code).emit('track:set', track);
    publish(room, socket.data.code);
    reply(cb, { ok: true });
  });

  socket.on('device:status', (data = {}) => {
    const room = rooms[socket.data.code];
    if (!room || !room.track || data.trackId !== room.track.id) return;
    const statuses = ['prepared', 'ready', 'loading', 'buffering', 'blocked', 'error'];
    if (!statuses.includes(data.status)) return;
    // Delayed readiness or buffering from an old timeline must not alter the current one.
    if (data.revision !== room.state.revision) return;
    updateTiming(data.timing);
    const previous = room.devices[socket.id];
    room.devices[socket.id] = { ready: ['prepared', 'ready'].includes(data.status), status: data.status,
      participating: previous?.participating || (data.status === 'ready' && room.state.playing) };
    // A late join is prepared independently. Only an already participating
    // speaker can request a room-wide recovery after playback has started.
    if (room.state.playing && previous?.participating && ['buffering', 'blocked', 'error'].includes(data.status) &&
      serverNow() >= room.state.serverPlayAt + 500) {
      waitTogether(room, socket.data.code);
    } else {
      io.to(socket.data.code).emit('room:devices', room.devices);
      resumeIfReady(room, socket.data.code);
    }
  });

  socket.on('playback:command', (data = {}, cb) => {
    const room = hostRoom();
    if (!room || !room.track || data.trackId !== room.track.id) return reply(cb, { ok: false, error: 'Track is no longer active' });
    if (!['play', 'pause', 'seek'].includes(data.action) || !validPosition(data.position)) {
      return reply(cb, { ok: false, error: 'Invalid playback command' });
    }
    const playing = data.action === 'play' || (data.action === 'seek' && Boolean(room.state.playing || room.state.waiting));
    if (playing) {
      // Readiness at the old position says nothing about the requested position.
      waitTogether(room, socket.data.code, data.position);
      reply(cb, { ok: true, queued: true });
    } else {
      room.state = { playing: false, waiting: false, position: data.position,
        serverPlayAt: null, revision: room.state.revision + 1 };
      publish(room, socket.data.code);
      reply(cb, { ok: true, queued: false });
    }
  });

  // Live tab sharing retains its own WebRTC timing.
  socket.on('audio:play', () => {
    const room = hostRoom();
    if (!room || !room.track?.isScreenShare) return;
    room.state = { playing: true, position: 0, serverPlayAt: serverNow(), revision: room.state.revision + 1 };
  });
  socket.on('room:sync', (_, cb) => {
    const room = rooms[socket.data.code];
    if (room) reply(cb, { ok: true, ...snapshot(room) });
  });

  // ── WebRTC signalling (screen/tab audio mode) ─────────────────
  socket.on('webrtc:offer', ({ to, offer }) => {
    const room = rooms[socket.data.code];
    if (!room || ![room.host, ...room.listeners].includes(to) ||
      (socket.id !== room.host && to !== room.host)) return;
    io.to(to).emit('webrtc:offer', { from: socket.id, offer });
  });
  socket.on('webrtc:answer', ({ to, answer }) => {
    const room = rooms[socket.data.code];
    if (!room || ![room.host, ...room.listeners].includes(to) ||
      (socket.id !== room.host && to !== room.host)) return;
    io.to(to).emit('webrtc:answer', { from: socket.id, answer });
  });
  socket.on('webrtc:ice', ({ to, candidate }) => {
    const room = rooms[socket.data.code];
    if (!room || ![room.host, ...room.listeners].includes(to) ||
      (socket.id !== room.host && to !== room.host)) return;
    io.to(to).emit('webrtc:ice', { from: socket.id, candidate });
  });

  // ── Disconnect ────────────────────────────────────────────────
  socket.on('disconnect', () => {
    const { code, isHost } = socket.data;
    if (!code || !rooms[code]) return;
    const room = rooms[code];
    delete room.devices[socket.id];
    if (isHost) {
      // Preserve the timeline briefly so a transient network loss can resume.
      room.closeTimer = setTimeout(() => {
        io.to(code).emit('room:host_left');
        delete rooms[code];
      }, 20000);
      room.closeTimer.unref();
    } else {
      room.listeners = room.listeners.filter(id => id !== socket.id);
      io.to(room.host).emit('room:listener_left', { id: socket.id });
      io.to(code).emit('room:count', room.listeners.length);
    }
    io.to(code).emit('room:devices', room.devices);
    resumeIfReady(room, code);
  });
});

const rooms = Object.create(null);
function genCode() {
  const c = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 6; i++) s += c[Math.floor(Math.random() * c.length)];
  return s;
}

const pulse = setInterval(() => {
  for (const [code, room] of Object.entries(rooms)) {
    io.to(code).emit('room:state', { track: room.track, state: room.state, devices: room.devices, serverTime: serverNow() });
  }
}, 2000);
pulse.unref();
return { app, server, io, rooms, close: async () => {
  clearInterval(pulse);
  for (const room of Object.values(rooms)) clearTimeout(room.closeTimer);
  await new Promise(resolve => io.close(resolve));
} };
}

if (require.main === module) {
  const { server } = createWaveRoom();
  const port = process.env.PORT || 3000;
  server.listen(port, () => console.log(`WaveRoom on :${port}`));
}
module.exports = { createWaveRoom };
