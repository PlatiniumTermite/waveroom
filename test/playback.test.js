'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const WaveSync = require('../public/sync-model');

// Execute the browser controller with a deterministic clock and a fake IFrame
// boundary. The server tests separately exercise real Socket.IO connections.
function browser(options = {}) {
  let now = 10000, nextTimer = 0;
  const timers = new Map(), intervals = [], events = [], players = [], handlers = new Map();
  const elements = new Map();
  function element(id) {
    if (!elements.has(id)) elements.set(id, {
      textContent: '', hidden: true, value: id.endsWith('-advance') ? '0' : '0.85', style: {}, currentTime: 0, duration: 120,
      classList: { add() {}, remove() {}, toggle() {} }, replaceChildren() {}, appendChild() {},
      pause() {}, load() {}, removeAttribute() {},
      addEventListener() {}, setAttribute() {}
    });
    return elements.get(id);
  }
  class Player {
    constructor(mount, config) {
      this.config = config; this.time = 0; this.state = 5; this.plays = 0; this.playMuted = []; this.destroyed = false;
      players.push(this);
    }
    getCurrentTime() { return this.time; }
    getDuration() { return 120; }
    getPlayerState() { return this.state; }
    getVideoData() { return { title: 'Video title' }; }
    setVolume() {} setPlaybackRate() {} mute() { this.muted = true; } unMute() { this.muted = false; }
    pauseVideo() { this.state = 2; }
    playVideo() { this.playMuted.push(Boolean(this.muted)); this.plays++; this.state = 1; this.config.events.onStateChange({ data: 1 }); }
    seekTo(position) { this.time = position; }
    destroy() { this.destroyed = true; }
    ready() { this.config.events.onReady({ target: this }); }
  }
  const sources=[];
  const audioContext={state:'suspended',outputLatency:0.04,get currentTime(){return now/1000;},
    resume(){this.state='running';return Promise.resolve();},
    decodeAudioData:options.decode || (async()=>({duration:120})),
    createBufferSource(){const source={connect(){},disconnect(){},stop(){this.stopped=true;},
      start(when,offset){this.when=when;this.offset=offset;},playbackRate:{setValueAtTime(){}}};sources.push(source);return source;}
  };
  const context = vm.createContext({
    WaveSync, window: { YT: { Player, PlayerState: { PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5, ENDED: 0 } } },
    G: element, amHost: false, ntpDone: true, sock: { id: 'listener', emit: (...args) => events.push(args), on: (name, handler) => handlers.set(name, handler) },
    location: { origin: 'https://waveroom.test' }, performance: { now: () => now },
    document: { createElement: () => ({}), querySelectorAll: () => [] },
    BufferedRoomAudio:require('../public/buffered-audio'),
    AbortSignal, fetch:async()=>({ok:true,headers:{get:()=>null},body:{getReader(){let sent=false;return {async read(){if(sent)return {done:true};sent=true;return {value:new Uint8Array([1])};}};}}}),
    buildChain(){context.lCtx=audioContext;context.lEQ={sub:{}};},startViz(){},lAn:{},
    AbortController, setTimeout: (fn, delay) => { const id = ++nextTimer; timers.set(id, { fn, at: now + delay }); return id; },
    clearTimeout: id => timers.delete(id), setInterval: fn => intervals.push(fn),
    srvNow: () => now, currentTrack: null, progRaf: null, vizRaf: null,
    peerConns: {}, listeners: {}, stopScreenShare() {}, teardown() {}, doUnlock() {}, setSyncInfo() {},
    lCtx: null, hCtx: null, fmt: String, setPill() {}, toast() {},
    cancelAnimationFrame() {}, roomHostToken: null, roomCode: 'ABC123'
  });
  vm.runInContext(fs.readFileSync('public/playback.js', 'utf8') + '\nthis.controller = Playback;', context);
  async function snapshot(state, id = 'track-1') {
    context.controller.snapshot({ track: { id, kind: 'youtube', videoId: 'dQw4w9WgXcQ', title: 'Test', ...options.track }, state, devices: {} });
    // Allow the resolved iframe API promise to construct the player.
    await Promise.resolve(); await Promise.resolve();
  }
  function advance(value) {
    now = value;
    for (let rounds = 0; rounds < 10; rounds++) {
      const due = [...timers].filter(([, timer]) => timer.at <= now);
      if (!due.length) break;
      due.forEach(([id, timer]) => { timers.delete(id); timer.fn(); });
    }
    intervals.forEach(fn => fn());
  }
  return { context, snapshot, advance, players, events, elements, handlers, audioContext, sources };
}

test('a late listener catches up after its audio gesture using the original timeline', async () => {
  const b = browser();
  await b.snapshot({ playing: true, position: 5, serverPlayAt: 8000, revision: 1 });
  const player = b.players[0]; player.ready();
  assert.equal(b.events.at(-1)[1].status, 'blocked');
  await b.context.controller.enable();
  b.advance(10000);
  assert.equal(player.getCurrentTime(), 7);
  assert.equal(player.getPlayerState(), 1);
  assert.equal(b.events.at(-1)[1].status, 'ready');
});

test('Pause cancels a future start and preserves the paused position', async () => {
  const b = browser();
  await b.snapshot({ playing: true, position: 0, serverPlayAt: 20000, revision: 1 });
  const player = b.players[0]; player.ready();
  await b.context.controller.enable(); b.advance(10000);
  const initialPlays = player.plays;
  await b.snapshot({ playing: false, position: 12, serverPlayAt: null, revision: 2 });
  b.advance(22000);
  assert.equal(player.plays, initialPlays);
  assert.equal(player.getCurrentTime(), 12);
  assert.equal(player.getPlayerState(), 2);
});

test('ongoing drift correction catches up a stalled player', async () => {
  const b = browser();
  await b.snapshot({ playing: true, position: 0, serverPlayAt: 10000, revision: 1 });
  const player = b.players[0]; player.ready();
  await b.context.controller.enable(); b.advance(10000);
  player.time = 0.5;
  b.advance(14000);
  assert.equal(player.getCurrentTime(), 4);
});

test('track changes cancel stale starts and leaving destroys the player', async () => {
  const b = browser();
  await b.snapshot({ playing: true, position: 0, serverPlayAt: 20000, revision: 1 });
  const original = b.players[0]; original.ready();
  await b.context.controller.enable(); b.advance(10000);
  const initialPlays = original.plays;
  await b.snapshot({ playing: false, position: 0, serverPlayAt: null, revision: 2 }, 'track-2');
  assert.equal(original.destroyed, true);
  b.advance(21000);
  assert.equal(original.plays, initialPlays);
  b.context.controller.reset();
  assert.equal(b.players[1].destroyed, true);
});

test('a recovery revision quietly prepares once and acknowledges the matching revision', async () => {
  const b = browser();
  await b.snapshot({ playing: true, position: 0, serverPlayAt: 10000, revision: 1 });
  const player = b.players[0]; player.ready();
  b.context.controller.enable(); b.advance(10000);
  await b.snapshot({ playing: false, waiting: true, position: 5, serverPlayAt: null, revision: 2 });
  assert.equal(player.getCurrentTime(), 5);
  assert.equal(player.getPlayerState(), 2);
  const prepared = b.events.filter(args => args[0] === 'device:status' && args[1].status === 'prepared').at(-1)[1];
  assert.equal(prepared.revision, 2);
  const plays = player.plays;
  b.advance(11000); b.advance(12000);
  assert.equal(player.plays, plays);
  await b.snapshot({ playing: true, waiting: false, position: 5, serverPlayAt: 13500, revision: 3 });
  b.advance(13000); assert.equal(player.getPlayerState(), 2);
  b.advance(13500); assert.equal(player.getPlayerState(), 1);
});

test('later tracks reuse audio permission and prepare automatically', async () => {
  const b = browser();
  await b.snapshot({ playing: false, position: 0, serverPlayAt: null, revision: 1 });
  b.players[0].ready(); b.context.controller.enable(); b.advance(10000);
  await b.snapshot({ playing: false, position: 0, serverPlayAt: null, revision: 2 }, 'another-track');
  const next = b.players[1]; next.ready();
  assert.equal(next.plays, 1);
  assert.equal(b.events.at(-1)[1].status, 'prepared');
  assert.equal(b.elements.get('l-enable').hidden, true);
});

test('old frames after a seek cannot acknowledge preparation of the new position', async () => {
  const b = browser();
  await b.snapshot({ playing: false, position: 0, serverPlayAt: null, revision: 1 });
  const player = b.players[0]; player.ready();
  b.context.controller.enable(); b.advance(10000);
  // The real IFrame seek is asynchronous: Playing may still show old frames.
  player.seekTo = position => { player.pendingPosition = position; };
  await b.snapshot({ playing: false, waiting: true, position: 50, serverPlayAt: null, revision: 2 });
  assert.equal(player.muted, true);
  assert.equal(b.events.filter(item => item[0] === 'device:status' && item[1].status === 'prepared' && item[1].revision === 2).length, 0);
  player.time = player.pendingPosition;
  b.advance(10250);
  assert.equal(player.getPlayerState(), 2);
  assert.equal(b.events.at(-1)[1].status, 'prepared'); assert.equal(b.events.at(-1)[1].revision, 2);
});

test('preparation waits for clock measurement before acknowledging a device', async () => {
  const b = browser(); b.context.ntpDone = false;
  await b.snapshot({ playing: false, waiting: true, position: 10, serverPlayAt: null, revision: 1 });
  const player = b.players[0]; player.ready(); b.context.controller.enable();
  assert.equal(player.muted, true);
  assert.equal(b.events.at(-1)[1].status, 'loading');
  b.context.ntpDone = true; b.advance(10250);
  assert.equal(b.events.at(-1)[1].status, 'prepared');
});

test('a reconnect prepares the current position before reporting active playback', async () => {
  const b = browser();
  await b.snapshot({ playing: true, position: 0, serverPlayAt: 10000, revision: 1 });
  const player = b.players[0]; player.ready(); b.context.controller.enable(); b.advance(10000);
  b.context.controller.bind(); b.handlers.get('disconnect')();
  b.advance(15000);
  b.handlers.get('connect')();
  const join = b.events.filter(item => item[0] === 'room:join').at(-1);
  join[2]({ ok: true, track: { id: 'track-1', kind: 'youtube', videoId: 'dQw4w9WgXcQ' },
    state: { playing: true, position: 0, serverPlayAt: 10000, revision: 1 }, devices: {} });
  assert.equal(player.getCurrentTime(), 5);
  assert.equal(b.events.at(-1)[1].status, 'prepared');
  b.advance(15000);
  assert.equal(player.getPlayerState(), 1);
  assert.equal(b.events.at(-1)[1].status, 'ready');
});

test('a slow preparation callback can confirm a held paused position', async () => {
  const b = browser();
  await b.snapshot({ playing: false, waiting: true, position: 40, serverPlayAt: null, revision: 1 });
  const player = b.players[0]; player.ready();
  player.seekTo = position => { player.pendingPosition = position; };
  b.context.controller.enable();
  assert.equal(player.getPlayerState(), 2); assert.equal(player.muted, true);
  assert.equal(b.events.at(-1)[1].status, 'loading');
  player.time = player.pendingPosition;
  b.advance(14000); // A background tab delayed sampling by four seconds.
  assert.equal(b.events.at(-1)[1].status, 'prepared');
  assert.equal(player.getPlayerState(), 2); assert.equal(player.getCurrentTime(), 40);
});

test('a late Playing event after preparation timeout cannot release the room', async () => {
  const b = browser();
  await b.snapshot({ playing: false, waiting: true, position: 40, serverPlayAt: null, revision: 1 });
  const player = b.players[0]; player.ready();
  player.seekTo = () => {}; // Requested position cannot be prepared.
  b.context.controller.enable();
  b.advance(31000);
  assert.equal(b.events.at(-1)[1].status, 'error');
  player.state = 1; player.config.events.onStateChange({ data: 1 });
  assert.equal(b.events.at(-1)[1].status, 'error');
  assert.equal(player.getPlayerState(), 2); assert.equal(player.muted, true);
  b.context.controller.enable();
  await Promise.resolve(); await Promise.resolve();
  assert.equal(player.destroyed, true);
  const replacement = b.players[1]; replacement.ready();
  assert.equal(replacement.getCurrentTime(), 40);
  assert.equal(b.events.at(-1)[1].status, 'prepared');
});

test('scheduled playback enables sound at the deadline before asking the player to start', async () => {
  const b = browser();
  await b.snapshot({ playing: false, waiting: true, position: 0, serverPlayAt: null, revision: 1 });
  const player = b.players[0]; player.ready(); b.context.controller.enable(); b.advance(10000);
  assert.equal(player.playMuted[0], true);
  await b.snapshot({ playing: true, waiting: false, position: 0, serverPlayAt: 12000, revision: 2 });
  b.advance(11500); assert.equal(player.muted, true);
  b.advance(12000); assert.equal(player.playMuted.at(-1), false);
});


test('an iframe error before readiness can be retried at the latest room position', async () => {
  const b = browser();
  await b.snapshot({ playing: false, waiting: true, position: 12, serverPlayAt: null, revision: 3 });
  const failed = b.players[0];
  failed.config.events.onError({ data: 5 });
  assert.equal(b.elements.get('l-enable').hidden, false);
  b.context.controller.enable();
  await Promise.resolve(); await Promise.resolve();
  const replacement = b.players[1];
  assert.equal(failed.destroyed, true);
  replacement.ready();
  assert.equal(replacement.getCurrentTime(), 12);
  assert.equal(b.events.at(-1)[1].status, 'prepared');
  assert.equal(b.events.at(-1)[1].revision, 3);
  const eventCount = b.events.length;
  failed.config.events.onStateChange({ data: 1 });
  assert.equal(b.events.length, eventCount);
});


test('buffering after quiet preparation revokes it and prepares again while the room waits', async () => {
  const b = browser();
  await b.snapshot({ playing: false, waiting: true, position: 10, serverPlayAt: null, revision: 3 });
  const player = b.players[0]; player.ready(); b.context.controller.enable();
  assert.equal(b.events.at(-1)[1].status, 'prepared');
  const firstPlays = player.plays;
  player.state = 3; player.config.events.onStateChange({ data: 3 });
  assert.equal(b.events.at(-1)[1].status, 'buffering');
  b.advance(10250);
  assert.equal(player.plays, firstPlays + 1);
  assert.equal(b.events.at(-1)[1].status, 'prepared');
  assert.equal(b.events.at(-1)[1].revision, 3);
  assert.equal(player.muted, true);
});


test('buffered room playback waits for decoding and permission, then schedules ahead and cancels on pause', async () => {
  let decode;
  const b=browser({track:{kind:'audio',streamUrl:'/media/synthetic'},decode:()=>new Promise(resolve=>{decode=resolve;})});
  await b.snapshot({playing:false,waiting:true,position:5,serverPlayAt:null,revision:1});
  await new Promise(setImmediate);
  b.context.controller.enable();
  assert.equal(b.events.at(-1)[1].status,'loading');
  decode({duration:120});await new Promise(setImmediate);
  assert.equal(b.events.at(-1)[1].status,'blocked');
  b.context.controller.enable();await new Promise(setImmediate);
  assert.equal(b.events.at(-1)[1].status,'prepared');
  await b.snapshot({playing:true,waiting:false,position:5,serverPlayAt:12000,revision:2});
  assert.equal(b.sources.length,1);assert.equal(b.sources[0].when,11.96);
  assert.equal(b.sources[0].offset,5);
  await b.snapshot({playing:false,waiting:false,position:5,serverPlayAt:null,revision:3});
  assert.equal(b.sources[0].stopped,true);
  b.advance(13000);assert.notEqual(b.events.at(-1)[1].status,'ready');
});

test('an undecodable shared file reports a device error and never releases readiness', async () => {
  const b=browser({track:{kind:'audio',streamUrl:'/media/synthetic'},decode:async()=>{throw new Error('Unsupported audio');}});
  await b.snapshot({playing:false,waiting:true,position:0,serverPlayAt:null,revision:1});
  await new Promise(setImmediate);
  assert.equal(b.events.at(-1)[1].status,'error');
  assert.match(b.elements.get('l-device-status').textContent,/Unsupported audio.*retry/);
  assert.equal(b.sources.length,0);
});


test('a shared-file decode failure can retry without reloading the room', async () => {
  let attempts=0;
  const b=browser({track:{kind:'audio',streamUrl:'/media/synthetic'},decode:async()=>{
    if(++attempts===1)throw new Error('Temporary decode failure');return {duration:120};
  }});
  await b.snapshot({playing:false,waiting:true,position:15,serverPlayAt:null,revision:3});
  await new Promise(setImmediate);
  assert.equal(b.events.at(-1)[1].status,'error');assert.equal(b.elements.get('l-enable').hidden,false);
  b.context.controller.enable();await new Promise(setImmediate);
  assert.equal(attempts,2);assert.equal(b.events.at(-1)[1].status,'prepared');
  assert.equal(b.events.at(-1)[1].revision,3);
  assert.equal(b.elements.get('l-enable').hidden,true);
});

test('buffered audio loading works without AbortSignal.any or AbortSignal.timeout', async () => {
  const b=browser({track:{kind:'audio',streamUrl:'/media/synthetic'}});
  b.context.AbortSignal=undefined;
  await b.snapshot({playing:false,waiting:true,position:0,serverPlayAt:null,revision:1});
  await new Promise(setImmediate);
  assert.equal(b.events.at(-1)[1].status,'blocked');
  b.context.controller.enable();await new Promise(setImmediate);
  assert.equal(b.events.at(-1)[1].status,'prepared');
});

test('audio suspension cancels the old source and prepares the recovery position after enabling', async () => {
  const b=browser({track:{kind:'audio',streamUrl:'/media/synthetic'}});
  await b.snapshot({playing:false,waiting:true,position:0,serverPlayAt:null,revision:1});
  await new Promise(setImmediate);b.context.controller.enable();await new Promise(setImmediate);
  await b.snapshot({playing:true,waiting:false,position:0,serverPlayAt:12000,revision:2});
  b.advance(13000);b.audioContext.state='interrupted';b.advance(13250);
  assert.equal(b.events.at(-1)[1].status,'blocked');assert.equal(b.sources[0].stopped,true);
  await b.snapshot({playing:false,waiting:true,position:1.25,serverPlayAt:null,revision:3});
  b.context.controller.enable();await new Promise(setImmediate);
  assert.equal(b.events.at(-1)[1].status,'prepared');assert.equal(b.events.at(-1)[1].revision,3);
  await b.snapshot({playing:true,waiting:false,position:1.25,serverPlayAt:15000,revision:4});
  assert.equal(b.sources.length,2);assert.equal(b.sources[1].offset,1.25);
});

test('a large timing jump requests a coordinated recovery instead of minutes of slow catch-up', async () => {
  const b=browser({track:{kind:'audio',streamUrl:'/media/synthetic'}});
  await b.snapshot({playing:false,waiting:true,position:0,serverPlayAt:null,revision:1});
  await new Promise(setImmediate);b.context.controller.enable();await new Promise(setImmediate);
  await b.snapshot({playing:true,waiting:false,position:0,serverPlayAt:12000,revision:2});
  b.advance(13000);b.context.srvNow=()=>15250;b.advance(13250);
  assert.equal(b.events.at(-1)[1].status,'buffering');assert.equal(b.sources[0].stopped,true);
  await b.snapshot({playing:false,waiting:true,position:3.25,serverPlayAt:null,revision:3});
  assert.equal(b.events.at(-1)[1].status,'prepared');assert.equal(b.events.at(-1)[1].revision,3);
});

test('host controls use the shared timeline instead of a calibrated device position', async () => {
  const b=browser();b.context.sock.connected=true;
  await b.snapshot({playing:true,position:5,serverPlayAt:8000,revision:1});
  b.players[0].time=7.5;
  b.context.controller.command('pause');
  const command=b.events.findLast(e=>e[0]==='playback:command');
  assert.equal(command[1].position,7);
});

test('a late decode and its timeout cannot replace or abort a newer shared track', async () => {
  let finishOld,decodes=0;
  const b=browser({track:{kind:'audio',streamUrl:'/media/synthetic'},decode:()=>{
    if(++decodes===1)return new Promise(resolve=>{finishOld=resolve;});
    return Promise.resolve({duration:120});
  }});
  const signals=[],fetchAudio=b.context.fetch;
  b.context.fetch=(url,options)=>{signals.push(options.signal);return fetchAudio(url,options);};
  await b.snapshot({playing:false,waiting:true,position:0,serverPlayAt:null,revision:1});
  await new Promise(setImmediate);
  await b.snapshot({playing:false,waiting:true,position:10,serverPlayAt:null,revision:2},'new-track');
  await new Promise(setImmediate);
  b.context.controller.enable();await new Promise(setImmediate);
  assert.equal(b.events.at(-1)[1].trackId,'new-track');
  assert.equal(b.events.at(-1)[1].status,'prepared');
  b.advance(101000); // The old, still-decoding request reaches its deadline.
  assert.equal(signals[0].aborted,true);assert.equal(signals[1].aborted,false);
  finishOld({duration:15});await new Promise(setImmediate);
  assert.equal(b.context.controller.duration(),120);
  assert.equal(b.events.at(-1)[1].trackId,'new-track');
});
