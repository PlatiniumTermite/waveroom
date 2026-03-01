const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const path    = require('path');
const { execFile, spawn } = require('child_process');
const { promisify } = require('util');
const fs      = require('fs');

const execFileAsync = promisify(execFile);
const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*', methods: ['GET','POST','OPTIONS'] },
  transports: ['websocket','polling'],
  pingTimeout: 60000,
  pingInterval: 25000,
  maxHttpBufferSize: 50e6,   // 50 MB – needed for audio chunk relay
  perMessageDeflate: false,
});

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// ─── HEALTH ──────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

// Room existence check — lets frontend verify before joining
app.get('/room/:code', (req, res) => {
  const code = (req.params.code||'').trim().toUpperCase();
  const room = rooms[code];
  if (!room) return res.json({exists:false});
  res.json({exists:true, name:room.name, listeners:room.listeners.length, mode:room.mode||'url'});
});

// ─── CORS ────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Range');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Length,Content-Range,Accept-Ranges');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ─── yt-dlp (YouTube fallback) ───────────────────────────────────
const HOME       = process.env.HOME || '/opt/render';
const YTDLP_DIR  = path.join(HOME, '.local', 'bin');
const YTDLP_PATH = path.join(YTDLP_DIR, 'yt-dlp');
const CANDIDATES = [YTDLP_PATH, '/usr/local/bin/yt-dlp', '/usr/bin/yt-dlp', 'yt-dlp'];
let _ytBin = null;

async function findYtDlp() {
  if (_ytBin) return _ytBin;
  for (const b of CANDIDATES) {
    try { await execFileAsync(b, ['--version'], {timeout:5000}); _ytBin = b; return b; }
    catch {}
  }
  return null;
}

async function ensureYtDlp() {
  const found = await findYtDlp();
  if (found) return found;
  try { fs.mkdirSync(YTDLP_DIR, {recursive:true}); } catch {}
  // pip3 with break-system flag
  try {
    await execFileAsync('pip3',['install','--quiet','--user','--break-system-packages','yt-dlp'],{timeout:90000});
    _ytBin = null; const b = await findYtDlp(); if (b) return b;
  } catch(e) { console.warn('[yt-dlp] pip3:', e.message.split('\n')[0]); }
  // curl to home dir (writable, no root)
  try {
    await execFileAsync('curl',['-sL','https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp','-o',YTDLP_PATH],{timeout:60000});
    fs.chmodSync(YTDLP_PATH, 0o755);
    _ytBin = null; const b = await findYtDlp(); if (b) return b;
  } catch(e) { console.warn('[yt-dlp] curl:', e.message.split('\n')[0]); }
  throw new Error('yt-dlp unavailable');
}

// ─── YOUTUBE INFO ────────────────────────────────────────────────
// yt-dlp args that bypass YouTube bot detection in 2025
// player_client=tv,mweb uses TV/mobile clients which are less restricted
// android also works but TV is most reliable on server IPs
function ytdlpArgs(url, extra=[]) {
  return [
    '--no-playlist',
    '--no-warnings',
    '--quiet',
    '--extractor-args', 'youtube:player_client=tv,mweb',
    '--user-agent', 'Mozilla/5.0 (SMART-TV; Linux; Tizen 5.0) AppleWebKit/538.1 (KHTML, like Gecko) Version/5.0 TV Safari/538.1',
    '-f', 'bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio/best',
    ...extra,
    url,
  ];
}

app.get('/yt-info', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({error:'No URL'});
  if (!isYTUrl(url)) return res.status(400).json({error:'Not a YouTube URL'});
  try {
    const bin = await ensureYtDlp();
    const args = ytdlpArgs(url, ['--skip-download','--print-json']);
    console.log('[YT-INFO] Running:', bin, args.slice(0,4).join(' '), '...');
    const {stdout} = await execFileAsync(bin, args, {timeout:45000, maxBuffer:10*1024*1024});
    const info = JSON.parse(stdout.trim());
    res.json({title: info.title||'Unknown', duration: info.duration||0});
  } catch(e) {
    console.error('[YT-INFO] Error:', e.message.slice(0,300));
    let msg = e.message;
    if (msg.includes('403')||msg.includes('bot')||msg.includes('Sign in')||msg.includes('blocked'))
      msg = 'YouTube blocked the server IP. Use Screen Share tab — paste YouTube URL in Chrome and share the tab. Works 100%.';
    else if (msg.includes('unavailable')||msg.includes('removed'))
      msg = 'Video unavailable or removed.';
    else if (msg.includes('Private'))
      msg = 'This video is private.';
    else if (msg.includes('yt-dlp unavailable')||msg.includes('installation failed'))
      msg = 'yt-dlp not installed yet (server is still starting). Wait 30s and try again, or use Screen Share.';
    else if (msg.includes('ENOENT'))
      msg = 'yt-dlp binary not found. Use Screen Share instead.';
    res.status(500).json({error: msg});
  }
});

// ─── YOUTUBE STREAM ──────────────────────────────────────────────
app.get('/yt-stream', async (req, res) => {
  const url = req.query.url;
  if (!url || !isYTUrl(url)) return res.status(400).send('Bad URL');
  try {
    const bin = await ensureYtDlp();
    res.setHeader('Access-Control-Allow-Origin','*');
    res.setHeader('Content-Type','audio/mp4');
    res.setHeader('Transfer-Encoding','chunked');
    res.setHeader('Cache-Control','no-cache');
    // Same bot-bypass args as yt-info
    const proc = spawn(bin, ytdlpArgs(url, ['-o','-']), {stdio:['ignore','pipe','pipe']});
    proc.stdout.pipe(res);
    let se=''; proc.stderr.on('data',d=>{se+=d;});
    proc.on('error',e=>{if(!res.headersSent)res.status(500).send(e.message);else res.end();});
    proc.on('close',code=>{if(code!==0&&se)console.warn('[YT-STREAM]',code,se.slice(0,200));res.end();});
    req.on('close',()=>proc.kill('SIGTERM'));
  } catch(e) {
    if(!res.headersSent) res.status(500).send(e.message);
  }
});

// ─── PROXY ───────────────────────────────────────────────────────
app.get('/proxy', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).send('No URL');
  try {
    const fetch = require('node-fetch');
    const headers = {
      'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0',
      'Accept':'audio/*,*/*;q=0.9',
    };
    if (req.headers.range) headers['Range'] = req.headers.range;
    const up = await fetch(url, {headers});
    res.setHeader('Access-Control-Allow-Origin','*');
    res.setHeader('Content-Type', up.headers.get('content-type')||'audio/mpeg');
    res.setHeader('Accept-Ranges','bytes');
    const cl=up.headers.get('content-length'), cr=up.headers.get('content-range');
    if(cl) res.setHeader('Content-Length',cl);
    if(cr) res.setHeader('Content-Range',cr);
    res.status(up.status===206?206:200);
    up.body.pipe(res);
  } catch(e) { if(!res.headersSent) res.status(500).send(e.message); }
});

function isYTUrl(url) {
  try { return ['youtube.com','www.youtube.com','youtu.be','m.youtube.com','music.youtube.com'].includes(new URL(url).hostname); }
  catch { return false; }
}

// ─── ROOMS ───────────────────────────────────────────────────────
const rooms = {};
const ROOM_TTL = 6 * 3600 * 1000;

function makeCode() {
  const c='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({length:6},()=>c[Math.floor(Math.random()*c.length)]).join('');
}

setInterval(()=>{
  const now=Date.now(); let n=0;
  for(const [k,r] of Object.entries(rooms)) if(now-r.createdAt>ROOM_TTL){delete rooms[k];n++;}
  if(n) console.log(`[GC] ${n} rooms removed`);
}, 30*60*1000);

io.on('connection', socket => {
  console.log('[+]', socket.id);

  // ── NTP time sync ──────────────────────────────────────────────
  socket.on('ntp:ping', ({clientTime}) =>
    socket.emit('ntp:pong', {clientTime, serverTime: Date.now()}));

  socket.on('keepalive', () => socket.emit('keepalive-ack'));

  // ── Room management ────────────────────────────────────────────
  socket.on('room:create', ({name}, cb) => {
    let code=makeCode(), t=0;
    while(rooms[code]&&t++<100) code=makeCode();
    rooms[code] = {
      host: socket.id, name: name||'Audio Room',
      listeners: [], track: null,
      state: {playing:false, position:0, serverPlayAt:null},
      mode: 'url',    // 'url' | 'screen'
      createdAt: Date.now(),
    };
    socket.join(code);
    socket.data.code = code;
    socket.data.isHost = true;
    console.log(`[ROOM] Created ${code}`);
    cb({ok:true, code, name:rooms[code].name});
  });

  socket.on('room:join', ({code}, cb) => {
    const normalCode = (code||'').toString().trim().toUpperCase();
    console.log(`[ROOM] Join attempt: "${normalCode}" | Active rooms: [${Object.keys(rooms).join(', ')||'none'}]`);
    const room = rooms[normalCode];
    if (!room) {
      console.log(`[ROOM] NOT FOUND: "${normalCode}"`);
      return cb({ok:false, error:'Room not found'});
    }
    room.listeners.push(socket.id);
    socket.join(normalCode);
    socket.data.code = normalCode;
    socket.data.isHost = false;
    io.to(room.host).emit('room:listener_joined', {id:socket.id});
    io.to(normalCode).emit('room:count', room.listeners.length);
    cb({ok:true, name:room.name, track:room.track, state:room.state, mode:room.mode||'url'});
    console.log(`[ROOM] ${socket.id} successfully joined ${normalCode}`);
  });

  // ── Track (URL mode) ───────────────────────────────────────────
  socket.on('track:set', ({streamUrl, title, originalUrl}) => {
    const room = rooms[socket.data.code];
    if (!room||room.host!==socket.id) return;
    room.track  = {streamUrl,title,originalUrl};
    room.state  = {playing:false,position:0,serverPlayAt:null};
    room.mode   = 'url';
    socket.to(socket.data.code).emit('track:set', {streamUrl,title,originalUrl});
  });

  // ── YouTube IFrame sync relay ──────────────────────
  socket.on('yt:load', ({videoId, title}) => {
    const room = rooms[socket.data.code];
    if (!room||room.host!==socket.id) return;
    room.track = {isYT:true, videoId, title};
    room.state = {playing:false, position:0, serverPlayAt:null};
    room.mode  = 'yt';
    socket.to(socket.data.code).emit('yt:load', {videoId, title});
    console.log(`[YT] ${socket.data.code} loaded: ${title}`);
  });
  socket.on('yt:play', ({position, serverPlayAt}) => {
    const room = rooms[socket.data.code];
    if (!room||room.host!==socket.id) return;
    room.state = {playing:true, position, serverPlayAt};
    socket.to(socket.data.code).emit('yt:play', {position, serverPlayAt});
  });
  socket.on('yt:pause', ({position}) => {
    const room = rooms[socket.data.code];
    if (!room||room.host!==socket.id) return;
    room.state = {playing:false, position, serverPlayAt:null};
    socket.to(socket.data.code).emit('yt:pause', {position});
  });
  socket.on('yt:seek', ({position, playing, serverPlayAt}) => {
    const room = rooms[socket.data.code];
    if (!room||room.host!==socket.id) return;
    room.state = {playing, position, serverPlayAt: playing?serverPlayAt:null};
    socket.to(socket.data.code).emit('yt:seek', {position, playing, serverPlayAt});
  });

  socket.on('audio:play', ({position,serverPlayAt}) => {
    const room = rooms[socket.data.code];
    if (!room||room.host!==socket.id) return;
    room.state = {playing:true,position,serverPlayAt};
    socket.to(socket.data.code).emit('audio:play', {position,serverPlayAt});
  });

  socket.on('audio:pause', ({position}) => {
    const room = rooms[socket.data.code];
    if (!room||room.host!==socket.id) return;
    room.state = {playing:false,position,serverPlayAt:null};
    socket.to(socket.data.code).emit('audio:pause', {position});
  });

  socket.on('audio:seek', ({position,playing,serverPlayAt}) => {
    const room = rooms[socket.data.code];
    if (!room||room.host!==socket.id) return;
    room.state = {playing,position,serverPlayAt:playing?serverPlayAt:null};
    socket.to(socket.data.code).emit('audio:seek', {position,playing,serverPlayAt});
  });

  // ── Screen Share / Live Audio mode ────────────────────────────
  // Host streams raw PCM/WebM audio chunks → server relays to all listeners
  // This is the Google-Meet-style approach: zero YouTube dependency
  socket.on('stream:start', ({title}) => {
    const room = rooms[socket.data.code];
    if (!room||room.host!==socket.id) return;
    room.mode  = 'screen';
    room.title = title||'Live Stream';
    room.state = {playing:true, position:0, serverPlayAt:Date.now()};
    socket.to(socket.data.code).emit('stream:start', {title:room.title, serverTime:Date.now()});
    console.log(`[STREAM] ${socket.data.code} started live: ${title}`);
  });

  // Relay audio chunk to all listeners (binary or base64)
  socket.on('stream:chunk', (chunk) => {
    const code = socket.data.code;
    const room = rooms[code];
    if (!room||room.host!==socket.id) return;
    // Forward to all listeners verbatim
    socket.to(code).emit('stream:chunk', chunk);
  });

  socket.on('stream:stop', () => {
    const room = rooms[socket.data.code];
    if (!room||room.host!==socket.id) return;
    room.mode = 'url';
    room.state.playing = false;
    socket.to(socket.data.code).emit('stream:stop');
    console.log(`[STREAM] ${socket.data.code} stopped live`);
  });

  // ── WebRTC signaling (peer-to-peer for lowest latency) ─────────
  socket.on('rtc:offer', ({offer, to}) => {
    io.to(to).emit('rtc:offer', {offer, from: socket.id});
  });
  socket.on('rtc:answer', ({answer, to}) => {
    io.to(to).emit('rtc:answer', {answer, from: socket.id});
  });
  socket.on('rtc:ice', ({candidate, to}) => {
    io.to(to).emit('rtc:ice', {candidate, from: socket.id});
  });

  // ── Disconnect ─────────────────────────────────────────────────
  socket.on('disconnect', reason => {
    const code = socket.data.code;
    if (!code||!rooms[code]) return;
    console.log(`[-] ${socket.id} (${reason})`);
    if (socket.data.isHost) {
      io.to(code).emit('room:host_left');
      delete rooms[code];
    } else {
      rooms[code].listeners = rooms[code].listeners.filter(id=>id!==socket.id);
      if (rooms[code]) {
        io.to(rooms[code].host).emit('room:listener_left', {id:socket.id});
        io.to(code).emit('room:count', rooms[code].listeners.length);
      }
    }
  });
});

// ─── START ───────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🌊 WaveRoom v3 on port ${PORT}`);
  console.log(`   HOME=${HOME}  yt-dlp target=${YTDLP_PATH}`);
  ensureYtDlp()
    .then(b => console.log(`✅ yt-dlp ready: ${b}`))
    .catch(e => console.warn(`⚠️  yt-dlp: ${e.message} (Screen Share mode still works)`));
});
