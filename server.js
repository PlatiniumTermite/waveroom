'use strict';
const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const path       = require('path');

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
  res.json({ ok: true, rooms: Object.keys(rooms).length, ts: Date.now() })
);

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
    res.status(up.status === 206 ? 206 : 200);
    req.on('close', () => { try { up.body.destroy(); } catch(_){} });
    up.body.pipe(res);
  } catch(e) {
    console.error('[PROXY]', e.message);
    if (!res.headersSent) res.status(500).send('Proxy error: ' + e.message);
  }
});

// ── YouTube info + stream ─────────────────────────────────────────
app.get('/yt-info', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: 'No URL' });
  let lastErr = 'unknown';

  // Attempt 1: @distube/ytdl-core
  try {
    const ytdl = require('@distube/ytdl-core');
    if (!ytdl.validateURL(url)) return res.status(400).json({ error: 'Invalid YouTube URL' });
    const info    = await ytdl.getInfo(url, { requestOptions: { headers: { 'User-Agent': 'Mozilla/5.0' }}});
    const formats = ytdl.filterFormats(info.formats, 'audioonly');
    const mp4     = formats.filter(f => f.container==='mp4' && f.audioBitrate).sort((a,b)=>b.audioBitrate-a.audioBitrate)[0];
    const best    = mp4 || formats.sort((a,b)=>(b.audioBitrate||0)-(a.audioBitrate||0))[0];
    if (!best) throw new Error('No audio format');
    return res.json({ ok:true, title:info.videoDetails.title,
      duration:+info.videoDetails.lengthSeconds,
      streamEndpoint:'/yt-stream?url='+encodeURIComponent(url) });
  } catch(e) { lastErr = e.message; console.warn('[yt-info ytdl]', e.message); }

  // Attempt 2: play-dl
  try {
    const pd   = require('play-dl');
    const info = await pd.video_info(url);
    return res.json({ ok:true, title:info.video_details.title,
      duration:info.video_details.durationInSec,
      streamEndpoint:'/yt-stream?url='+encodeURIComponent(url) });
  } catch(e) { lastErr = e.message; console.warn('[yt-info playdl]', e.message); }

  res.status(500).json({ error: 'YouTube blocked the request. Use a direct MP3 URL instead. Error: '+lastErr });
});

app.get('/yt-stream', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).send('No URL');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-cache');

  // Attempt 1: @distube/ytdl-core
  try {
    const ytdl    = require('@distube/ytdl-core');
    const info    = await ytdl.getInfo(url, { requestOptions: { headers: { 'User-Agent': 'Mozilla/5.0' }}});
    const formats = ytdl.filterFormats(info.formats, 'audioonly');
    const mp4     = formats.filter(f => f.container==='mp4' && f.audioBitrate).sort((a,b)=>b.audioBitrate-a.audioBitrate)[0];
    const chosen  = mp4 || formats.sort((a,b)=>(b.audioBitrate||0)-(a.audioBitrate||0))[0];
    if (!chosen) throw new Error('No format');
    res.setHeader('Content-Type', mp4 ? 'audio/mp4' : 'audio/webm');
    const s = ytdl(url, { format: chosen, highWaterMark: 1<<25 });
    req.on('close', () => { try { s.destroy(); } catch(_){} });
    s.on('error', e => { console.error('[stream ytdl]', e.message); if(!res.headersSent) res.end(); });
    s.pipe(res);
    return;
  } catch(e) { console.warn('[stream ytdl]', e.message); }

  // Attempt 2: play-dl
  try {
    const pd  = require('play-dl');
    const s   = await pd.stream(url, { quality: 2 });
    res.setHeader('Content-Type', 'audio/webm');
    req.on('close', () => { try { s.stream.destroy(); } catch(_){} });
    s.stream.on('error', e => { console.error('[stream playdl]', e.message); if(!res.headersSent) res.end(); });
    s.stream.pipe(res);
    return;
  } catch(e) { console.warn('[stream playdl]', e.message); }

  if (!res.headersSent) res.status(500).send('YouTube stream failed — use a direct MP3 URL');
});

// ── WebRTC signalling (for screen audio capture mode) ────────────
// Host captures screen/tab audio → sends WebRTC offer to each listener
io.on('connection', socket => {

  socket.on('ntp:ping', ({ clientTime }) =>
    socket.emit('ntp:pong', { clientTime, serverTime: Date.now() })
  );
  socket.on('keepalive', () => socket.emit('keepalive-ack'));

  // ── Room management ───────────────────────────────────────────
  socket.on('room:create', ({ name }, cb) => {
    let code = genCode();
    while (rooms[code]) code = genCode();
    rooms[code] = {
      host: socket.id, name: name || 'Audio Room',
      listeners: [], track: null,
      state: { playing: false, position: 0, serverPlayAt: null }
    };
    socket.join(code);
    socket.data.code   = code;
    socket.data.isHost = true;
    console.log('[+] Room', code, '| total:', Object.keys(rooms).length);
    cb({ ok: true, code, name: rooms[code].name });
  });

  socket.on('room:join', ({ code }, cb) => {
    const room = rooms[code];
    console.log('[?] join', code, '| found:', !!room, '| rooms:', Object.keys(rooms).join(','));
    if (!room) return cb({ ok: false, error: 'Room not found' });
    room.listeners.push(socket.id);
    socket.join(code);
    socket.data.code   = code;
    socket.data.isHost = false;
    io.to(room.host).emit('room:listener_joined', { id: socket.id });
    io.to(code).emit('room:count', room.listeners.length);
    cb({ ok: true, name: room.name, track: room.track, state: room.state });
  });

  // ── Track sync (URL mode) ─────────────────────────────────────
  socket.on('track:set', data => {
    const { code } = socket.data;
    const room = rooms[code];
    if (!room || room.host !== socket.id) return;
    room.track = data;
    room.state = { playing: false, position: 0, serverPlayAt: null };
    socket.to(code).emit('track:set', data);
    console.log('[♪]', code, data.title);
  });

  socket.on('audio:play', ({ position, serverPlayAt }) => {
    const { code } = socket.data; const room = rooms[code];
    if (!room || room.host !== socket.id) return;
    room.state = { playing: true, position, serverPlayAt };
    socket.to(code).emit('audio:play', { position, serverPlayAt });
  });

  socket.on('audio:pause', ({ position }) => {
    const { code } = socket.data; const room = rooms[code];
    if (!room || room.host !== socket.id) return;
    room.state = { playing: false, position, serverPlayAt: null };
    socket.to(code).emit('audio:pause', { position });
  });

  socket.on('audio:seek', ({ position, playing, serverPlayAt }) => {
    const { code } = socket.data; const room = rooms[code];
    if (!room || room.host !== socket.id) return;
    room.state = { playing, position, serverPlayAt: playing ? serverPlayAt : null };
    socket.to(code).emit('audio:seek', { position, playing, serverPlayAt });
  });

  // ── WebRTC signalling (screen/tab audio mode) ─────────────────
  socket.on('webrtc:offer', ({ to, offer }) => {
    io.to(to).emit('webrtc:offer', { from: socket.id, offer });
  });
  socket.on('webrtc:answer', ({ to, answer }) => {
    io.to(to).emit('webrtc:answer', { from: socket.id, answer });
  });
  socket.on('webrtc:ice', ({ to, candidate }) => {
    io.to(to).emit('webrtc:ice', { from: socket.id, candidate });
  });

  // ── Disconnect ────────────────────────────────────────────────
  socket.on('disconnect', () => {
    const { code, isHost } = socket.data;
    if (!code || !rooms[code]) return;
    if (isHost) {
      io.to(code).emit('room:host_left');
      delete rooms[code];
      console.log('[-] Room', code, '| total:', Object.keys(rooms).length);
    } else {
      rooms[code].listeners = rooms[code].listeners.filter(id => id !== socket.id);
      if (rooms[code]) {
        io.to(rooms[code].host).emit('room:listener_left', { id: socket.id });
        io.to(code).emit('room:count', rooms[code].listeners.length);
      }
    }
  });
});

const rooms = {};
function genCode() {
  const c = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 6; i++) s += c[Math.floor(Math.random() * c.length)];
  return s;
}

// Self-ping to keep Render free tier alive
const PORT     = process.env.PORT || 3000;
const SELF_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
setInterval(async () => {
  try { const f = require('node-fetch'); await f(SELF_URL + '/health'); }
  catch(e) { console.warn('[ping]', e.message); }
}, 13 * 60 * 1000);

server.listen(PORT, () => console.log(`WaveRoom v3 on :${PORT}`));
