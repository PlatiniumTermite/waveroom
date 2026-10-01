'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { io } = require('socket.io-client');
const { createWaveRoom } = require('../server');
const { youtubeId, positionAt } = require('../public/sync-model');

async function setup(t, options) {
  const app = createWaveRoom(options);
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${app.server.address().port}`;
  const clients = [];
  t.after(async () => { clients.forEach(client => client.disconnect()); await app.close(); });
  async function connect() {
    const client = io(url, { transports: ['websocket'], reconnection: false });
    clients.push(client);
    await new Promise((resolve, reject) => { client.once('connect', resolve); client.once('connect_error', reject); });
    return client;
  }
  const host = await connect();
  const room = await emit(host, 'room:create', { name: 'Test room' });
  return { ...app, host, room, url, connect };
}
function emit(client, event, data) {
  return new Promise((resolve, reject) => client.timeout(2000).emit(event, data, (error, result) => error ? reject(error) : resolve(result)));
}
function event(client, name, matches = () => true) {
  return new Promise(resolve => {
    const receive = data => { if (!matches(data)) return; client.off(name, receive); resolve(data); };
    client.on(name, receive);
  });
}
async function track(host) {
  assert.equal((await emit(host, 'track:set', { kind: 'youtube', originalUrl: 'https://youtu.be/dQw4w9WgXcQ' })).ok, true);
  return emit(host, 'room:sync', {});
}
async function ready(client, trackId) {
  const updated = event(client, 'room:devices');
  const snapshot = await emit(client, 'room:sync', {});
  client.emit('device:status', { trackId, status: 'ready', revision: snapshot.state.revision });
  await updated;
}

test('YouTube links and the timeline handle late and early starts', () => {
  for (const link of ['https://youtu.be/dQw4w9WgXcQ?t=20', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://music.youtube.com/watch?v=dQw4w9WgXcQ', 'https://www.youtube.com/shorts/dQw4w9WgXcQ']) {
    assert.equal(youtubeId(link), 'dQw4w9WgXcQ');
  }
  for (const link of ['https://youtube.com.evil.com/watch?v=dQw4w9WgXcQ', 'https://youtu.be/short', 'javascript:alert(1)',
    'https://youtube.com/playlist?list=anything']) assert.equal(youtubeId(link), null);
  const state = { playing: true, position: 4, serverPlayAt: 10000 };
  assert.equal(positionAt(state, 9000), 4);
  assert.equal(positionAt(state, 11500), 5.5);
  assert.equal(positionAt({ ...state, playing: false }, 20000), 4);
});

test('host and listener receive the same future start; late joins never reset the track', async t => {
  const { host, room, connect } = await setup(t);
  const listener = await connect();
  await emit(listener, 'room:join', { code: room.code });
  const snapshot = await track(host);
  const trackId = snapshot.track.id;
  const early = await emit(host, 'playback:command', { trackId, action: 'play', position: 10 });
  assert.equal(early.ok, true); assert.equal(early.queued, true);
  await emit(host, 'playback:command', { trackId, action: 'pause', position: 10 });
  await ready(host, trackId); await ready(listener, trackId);
  const before = Date.now();
  assert.equal((await emit(host, 'playback:command', { trackId, action: 'play', position: 10 })).ok, true);
  const hostState = event(host, 'room:state', data => data.state.playing),
    listenerState = event(listener, 'room:state', data => data.state.playing);
  await ready(host, trackId); await ready(listener, trackId);
  const [h, l] = await Promise.all([hostState, listenerState]);
  assert.deepEqual(h.state, l.state);
  assert.ok(h.state.serverPlayAt >= before + 350);
  const late = await connect();
  const joined = await emit(late, 'room:join', { code: room.code.toLowerCase() });
  assert.equal(joined.track.id, trackId);
  assert.deepEqual(joined.state, h.state);
  const after = await emit(host, 'room:sync', {});
  assert.deepEqual(after.state, h.state);
});

test('paused seek, invalid commands, stale tracks, and listener controls', async t => {
  const { host, room, connect } = await setup(t);
  const listener = await connect(); await emit(listener, 'room:join', { code: room.code });
  const snapshot = await track(host); const trackId = snapshot.track.id;
  assert.equal((await emit(listener, 'track:set', { kind: 'youtube', originalUrl: 'https://youtu.be/dQw4w9WgXcQ' })).ok, false);
  assert.equal((await emit(listener, 'playback:command', { trackId, action: 'play', position: 0 })).ok, false);
  for (const position of [-1, null, '10', Infinity]) {
    assert.equal((await emit(host, 'playback:command', { trackId, action: 'seek', position })).ok, false);
  }
  assert.equal((await emit(host, 'playback:command', { trackId: 'old', action: 'play', position: 0 })).ok, false);
  await emit(host, 'playback:command', { trackId, action: 'seek', position: 45 });
  const state = (await emit(listener, 'room:sync', {})).state;
  assert.equal(state.playing, false); assert.equal(state.position, 45); assert.equal(state.serverPlayAt, null);
  await ready(host, trackId); await ready(listener, trackId);
  await emit(host, 'playback:command', { trackId, action: 'play', position: 45 });
  await emit(host, 'playback:command', { trackId, action: 'pause', position: 45 });
  assert.equal((await emit(listener, 'room:sync', {})).state.playing, false);
});

test('host session resumes with its private token after disconnect', async t => {
  const { host, room, connect, rooms } = await setup(t);
  const original = await track(host);
  const gone = event(host, 'disconnect'); host.disconnect(); await gone;
  // A request over the new connection ensures the server has processed the disconnect.
  const replacement = await connect();
  assert.equal((await emit(replacement, 'room:join', { code: room.code, hostToken: 'wrong' })).ok, false);
  const result = await emit(replacement, 'room:join', { code: room.code, hostToken: room.hostToken });
  assert.equal(result.ok, true); assert.equal(result.track.id, original.track.id);
  assert.equal(rooms[room.code].host, replacement.id);
});

test('uploads require host authorization, stream seek ranges, and belong to their room', async t => {
  const { host, room, url, connect } = await setup(t);
  assert.equal((await fetch(url + '/upload?code=' + room.code, { method: 'POST', body: 'abc' })).status, 403);
  assert.equal((await fetch(url + '/upload?code=__proto__', { method: 'POST', body: 'abc' })).status, 403);
  const response = await fetch(url + '/upload?code=' + room.code, {
    method: 'POST', headers: { 'Content-Type': 'audio/wav', 'X-Room-Host': room.hostToken }, body: Buffer.from('0123456789')
  });
  assert.equal(response.status, 200); const { streamUrl } = await response.json();
  assert.equal((await emit(host, 'track:set', { streamUrl, title: 'Sample' })).ok, true);
  const part = await fetch(url + streamUrl, { headers: { Range: 'bytes=2-5' } });
  assert.equal(part.status, 206); assert.equal(part.headers.get('content-range'), 'bytes 2-5/10');
  assert.equal(await part.text(), '2345');
  const suffix = await fetch(url + streamUrl, { headers: { Range: 'bytes=-3' } });
  assert.equal(await suffix.text(), '789');
  assert.equal((await fetch(url + streamUrl, { headers: { Range: 'bytes=20-' } })).status, 416);
  const other = await connect(); await emit(other, 'room:create', { name: 'Another' });
  assert.equal((await emit(other, 'track:set', { streamUrl, title: 'Wrong room' })).ok, false);
});

test('malformed socket payloads cannot crash the room server', async t => {
  const { host } = await setup(t);
  assert.equal((await emit(host, 'track:set', null)).ok, false);
  assert.equal((await emit(host, 'playback:command', 'bad')).ok, false);
  host.emit('ntp:ping', null);
  const pong = event(host, 'ntp:pong');host.emit('ntp:ping',{t0:Date.now(),groupId:1,index:0});
  assert.ok(Number.isFinite((await pong).t1));
  assert.equal((await emit(host, 'room:sync', {})).ok, true);
});

test('direct audio proxy preserves upstream seek and error status', async t => {
  const { url } = await setup(t);
  const http = require('node:http');
  const source = http.createServer((req, res) => {
    if (req.url === '/missing') { res.writeHead(404); res.end('Missing'); return; }
    assert.equal(req.headers.range, 'bytes=1-3');
    res.writeHead(206, { 'Content-Type': 'audio/wav', 'Content-Range': 'bytes 1-3/10', 'Accept-Ranges': 'bytes' });
    res.end('123');
  });
  await new Promise(resolve => source.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => source.close(resolve)));
  const target = `http://127.0.0.1:${source.address().port}`;
  const part = await fetch(url + '/proxy?url=' + encodeURIComponent(target + '/audio'), { headers: { Range: 'bytes=1-3' } });
  assert.equal(part.status, 206); assert.equal(part.headers.get('content-range'), 'bytes 1-3/10');
  assert.equal(await part.text(), '123');
  assert.equal((await fetch(url + '/proxy?url=' + encodeURIComponent(target + '/missing'))).status, 404);
});

test('Play queues until every device prepares the current revision, then starts automatically', async t => {
  const { host, room, connect } = await setup(t);
  const listener = await connect(); await emit(listener, 'room:join', { code: room.code });
  const { track: media } = await track(host);
  const result = await emit(host, 'playback:command', { trackId: media.id, action: 'play', position: 15 });
  assert.equal(result.ok, true); assert.equal(result.queued, true);
  const waiting = (await emit(host, 'room:sync', {})).state;
  assert.equal(waiting.waiting, true); assert.equal(waiting.playing, false);
  host.emit('device:status', { trackId: media.id, status: 'ready', revision: waiting.revision - 1 });
  assert.equal((await emit(host, 'room:sync', {})).devices[host.id].ready, false);
  await ready(host, media.id);
  assert.equal((await emit(host, 'room:sync', {})).state.waiting, true);
  const started = event(host, 'room:state');
  await ready(listener, media.id);
  const state = (await started).state;
  assert.equal(state.waiting, false); assert.equal(state.playing, true); assert.equal(state.position, 15);
  assert.ok(state.serverPlayAt > Date.now() + 300);
});

test('buffering freezes the room and all speakers resume from the same position', async t => {
  const { host, room, rooms, connect } = await setup(t);
  const listener = await connect(); await emit(listener, 'room:join', { code: room.code });
  const { track: media } = await track(host);
  await ready(host, media.id); await ready(listener, media.id);
  await emit(host, 'playback:command', { trackId: media.id, action: 'play', position: 10 });
  await ready(host, media.id); await ready(listener, media.id);
  await emit(host, 'room:sync', {});
  // Advance the running timeline without a real-time sleep.
  rooms[room.code].state.serverPlayAt = Date.now() - 4000;
  const recovery = event(host, 'room:state', data => data.state.waiting);
  listener.emit('device:status', { trackId: media.id, status: 'buffering', revision: rooms[room.code].state.revision });
  const frozen = (await recovery).state;
  assert.equal(frozen.playing, false); assert.equal(frozen.waiting, true);
  assert.ok(frozen.position >= 14 && frozen.position < 14.2);
  const snapshot = await emit(host, 'room:sync', {});
  assert.ok(Object.values(snapshot.devices).every(device => !device.ready));
  await ready(listener, media.id);
  assert.equal((await emit(host, 'room:sync', {})).state.waiting, true);
  const resumed = event(listener, 'room:state');
  await ready(host, media.id);
  const resumedState = (await resumed).state;
  assert.equal(resumedState.playing, true); assert.equal(resumedState.position, frozen.position);
});

test('Pause cancels queued playback; a departing blocked device releases a pending start', async t => {
  const { host, room, connect } = await setup(t);
  const listener = await connect(); await emit(listener, 'room:join', { code: room.code });
  const { track: media } = await track(host);
  await emit(host, 'playback:command', { trackId: media.id, action: 'play', position: 4 });
  await emit(host, 'playback:command', { trackId: media.id, action: 'pause', position: 4 });
  await ready(host, media.id); await ready(listener, media.id);
  assert.equal((await emit(host, 'room:sync', {})).state.playing, false);
  const blockedState = (await emit(listener, 'room:sync', {})).state;
  listener.emit('device:status', { trackId: media.id, status: 'blocked', revision: blockedState.revision });
  await emit(listener, 'room:sync', {});
  await emit(host, 'playback:command', { trackId: media.id, action: 'play', position: 4 });
  await ready(host, media.id);
  const resumed = event(host, 'room:state'); listener.disconnect();
  assert.equal((await resumed).state.playing, true);
});

test('pasting a YouTube link can queue playback without a separate Play command', async t => {
  const { host, room, connect } = await setup(t);
  const listener = await connect(); await emit(listener, 'room:join', { code: room.code });
  await emit(host, 'track:set', { kind: 'youtube', originalUrl: 'https://youtu.be/dQw4w9WgXcQ', autoplay: true });
  const snapshot = await emit(host, 'room:sync', {});
  assert.equal(snapshot.state.waiting, true); assert.equal(snapshot.state.playing, false);
  await ready(host, snapshot.track.id);
  const started = event(host, 'room:state');
  await ready(listener, snapshot.track.id);
  assert.equal((await started).state.playing, true);
});

test('seek and restart require fresh readiness at the requested position', async t => {
  const { host, room, connect } = await setup(t);
  const listener = await connect(); await emit(listener, 'room:join', { code: room.code });
  const { track: media } = await track(host);
  await emit(host, 'playback:command', { trackId: media.id, action: 'play', position: 5 });
  await ready(host, media.id); await ready(listener, media.id);
  const playing = (await emit(host, 'room:sync', {})).state;
  await emit(host, 'playback:command', { trackId: media.id, action: 'seek', position: 60 });
  const waiting = await emit(host, 'room:sync', {});
  assert.equal(waiting.state.waiting, true); assert.equal(waiting.state.position, 60);
  assert.ok(Object.values(waiting.devices).every(device => !device.ready));
  host.emit('device:status', { trackId: media.id, status: 'ready', revision: playing.revision });
  assert.equal((await emit(host, 'room:sync', {})).devices[host.id].ready, false);
  await ready(host, media.id);
  assert.equal((await emit(host, 'room:sync', {})).state.waiting, true);
  await ready(listener, media.id);
  assert.equal((await emit(host, 'room:sync', {})).state.position, 60);
  await emit(host, 'playback:command', { trackId: media.id, action: 'play', position: 0 });
  const restart = await emit(listener, 'room:sync', {});
  assert.equal(restart.state.waiting, true); assert.equal(restart.state.position, 0);
  assert.ok(Object.values(restart.devices).every(device => !device.ready));
});

test('a delayed buffering report cannot rewind the current timeline', async t => {
  const { host, room, rooms, connect } = await setup(t);
  const listener = await connect(); await emit(listener, 'room:join', { code: room.code });
  const { track: media } = await track(host);
  await emit(host, 'playback:command', { trackId: media.id, action: 'play', position: 0 });
  await ready(host, media.id); await ready(listener, media.id);
  rooms[room.code].state.serverPlayAt = Date.now() - 5000;
  const before = (await emit(host, 'room:sync', {})).state;
  listener.emit('device:status', { trackId: media.id, status: 'buffering', revision: before.revision - 1 });
  const after = await emit(listener, 'room:sync', {});
  assert.deepEqual(after.state, before); assert.equal(after.devices[listener.id].ready, true);
});

test('a prepared late joiner cannot pause established speakers before its first playback', async t => {
  const { host, room, rooms, connect } = await setup(t);
  const { track: media } = await track(host);
  await emit(host, 'playback:command', { trackId: media.id, action: 'play', position: 0 });
  await ready(host, media.id);
  rooms[room.code].state.serverPlayAt = Date.now() - 5000;
  const late = await connect(); await emit(late, 'room:join', { code: room.code });
  const before = (await emit(host, 'room:sync', {})).state;
  late.emit('device:status', { trackId: media.id, status: 'prepared', revision: before.revision });
  const prepared = await emit(late, 'room:sync', {});
  assert.equal(prepared.devices[late.id].ready, true);
  assert.equal(Boolean(prepared.devices[late.id].participating), false);
  late.emit('device:status', { trackId: media.id, status: 'buffering', revision: before.revision });
  assert.deepEqual((await emit(late, 'room:sync', {})).state, before);
  await ready(late, media.id);
  const recovery = event(host, 'room:state', data => data.state.waiting);
  late.emit('device:status', { trackId: media.id, status: 'buffering', revision: before.revision });
  assert.equal((await recovery).state.waiting, true);
});


test('YouTube shared audio requires host authorization and queues all devices from one media URL', async t => {
  let calls=0;
  const {host,room,url}=await setup(t,{resolveYoutube:async id=>{
    calls++;assert.equal(id,'dQw4w9WgXcQ');return {buffer:Buffer.from('synthetic m4a'),type:'audio/mp4',title:'Test song'};
  }});
  const post=(token,link)=>fetch(url+'/youtube?code='+room.code,{method:'POST',headers:{'Content-Type':'application/json','X-Room-Host':token},body:JSON.stringify({url:link})});
  assert.equal((await post('wrong','https://youtu.be/dQw4w9WgXcQ')).status,403);
  assert.equal((await post(room.hostToken,'https://example.com')).status,400);
  assert.equal(calls,0);
  const response=await post(room.hostToken,'https://youtu.be/dQw4w9WgXcQ');assert.equal(response.status,200);
  const media=await response.json();assert.equal(calls,1);
  assert.equal(await (await fetch(url+media.streamUrl)).text(),'synthetic m4a');
  await emit(host,'track:set',{kind:'audio',...media,autoplay:true});
  const snapshot=await emit(host,'room:sync',{});
  assert.equal(snapshot.track.kind,'audio');assert.equal(snapshot.track.streamUrl,media.streamUrl);
  assert.equal(snapshot.state.waiting,true);
});

test('YouTube preparation rejects overlapping jobs and discards results after a source change', async t => {
  let finish,started;
  const pending=new Promise(resolve=>{started=resolve;});
  const {host,room,url}=await setup(t,{resolveYoutube:()=>new Promise(resolve=>{finish=resolve;started();})});
  const post=()=>fetch(url+'/youtube?code='+room.code,{method:'POST',headers:{'Content-Type':'application/json','X-Room-Host':room.hostToken},body:JSON.stringify({url:'https://youtu.be/dQw4w9WgXcQ'})});
  const request=post();await pending;
  assert.equal((await post()).status,429);
  await track(host);
  finish({buffer:Buffer.from('stale'),type:'audio/mp4',title:'Stale'});
  assert.equal((await request).status,409);
});


test('clock probes return ordered server timestamps and readiness includes slow-device headroom', async t => {
  const {host}=await setup(t);
  const response=event(host,'ntp:pong');
  host.emit('ntp:ping',{t0:Date.now(),groupId:1,index:0,rtt:600,compensationMs:1000});
  const pong=await response;
  assert.equal(pong.groupId,1);assert.equal(pong.index,0);assert.ok(pong.t2>=pong.t1);
  await track(host);
  const initial=await emit(host,'room:sync',{});
  await emit(host,'playback:command',{trackId:initial.track.id,action:'play',position:0});
  const waiting=await emit(host,'room:sync',{});
  const start=event(host,'room:state',d=>d.state.playing);
  const before=Date.now();
  host.emit('device:status',{trackId:initial.track.id,status:'prepared',revision:waiting.state.revision,
    timing:{rtt:700,compensationMs:1400}});
  const result=await start;
  assert.ok(result.state.serverPlayAt>=before+1550);
  assert.ok(result.state.serverPlayAt<before+2200);
});
