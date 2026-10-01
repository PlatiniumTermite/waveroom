'use strict';

// One authoritative timeline drives the host and every listener.
const Playback = (() => {
  let track = null, timeline = null, player = null, youtubePromise = null;
  let generation = 0, timer = null, loadTimeout = null, ready = false, status = '', enabled = false;
  let revision = -1, lastSeek = 0, disconnected = false;
  let audioAllowed = false, buffered = null;
  let preparedRevision = -1, preparing = false, playedForPreparation = false, preparationTimeout = null, preparationPoll = null, lastBufferReport = 0;
  let resuming = false, loadAbort = new AbortController();
  const side = () => amHost ? 'h' : 'l';
  const audio = () => G(side() + '-audio');
  const isYoutube = () => track?.kind === 'youtube';
  const mediaTime = () => isYoutube() ? player?.getCurrentTime() || 0 : buffered ? buffered.position : audio().currentTime;
  const duration = () => isYoutube() ? player?.getDuration() || 0 : buffered ? buffered.duration : audio().duration;
  const pause = () => { if (isYoutube()) player?.pauseVideo(); else if(buffered)buffered.stop(); else audio().pause(); };
  const seek = value => {
    const target = Math.max(0, Math.min(value, duration() || value));
    if (isYoutube()) player?.seekTo(target, true);
    else if (buffered) buffered.stop(target);
    else if (audio().readyState) audio().currentTime = target;
    lastSeek = performance.now();
  };
  function compensation() {
    return buffered?Math.min(2000,Math.max(0,buffered.outputDelay*1000+buffered.advanceMs)):0;
  }
  function report(value, force = false) {
    if (!track || (status === value && !force)) return;
    status = value;
    if (value === 'buffering' && !preparing) preparedRevision = -1;
    sock?.emit('device:status', { trackId: track.id, status: value, revision: timeline?.revision,
      timing:{rtt:typeof roomClock!=='undefined'?(roomClock?.rtt||0):0,compensationMs:compensation()} });
    const label = { prepared: 'Ready', ready: 'Ready', loading: 'Loading', blocked: 'Enable Audio', buffering: 'Buffering', error: 'Playback error' }[value];
    G(side() + '-device-status').textContent = label;
  }
  function needsGesture() {
    cancel(); pause();
    preparing = false; preparedRevision = -1; clearTimeout(preparationTimeout); clearTimeout(preparationPoll);
    enabled = false;
    report('blocked');
    G(side() + '-enable').hidden = false;
    if (!amHost) G('unlock').classList.remove('gone');
  }
  function play() {
    if (isYoutube()) player?.playVideo();
    else {
      const context = amHost ? hCtx : lCtx;
      if (context?.state === 'suspended') context.resume().catch(() => {});
      audio().play().catch(needsGesture);
    }
  }
  function cancel() { clearTimeout(timer); timer = null; }
  function mute(value) {
    if (isYoutube()) { if(value)player?.mute(); else player?.unMute(); }
    else audio().muted = value;
  }
  function prepare(state) {
    if (!ready || !state || (state.waiting && preparedRevision === state.revision)) return;
    if(buffered){
      if(buffered.context.state!=='running'){needsGesture();return;}
      if(!ntpDone){report('loading');G(side()+'-device-status').textContent='Synchronizing device clock…';return;}
      preparedRevision=state.revision; preparing=false; cancel(); pause();
      seek(WaveSync.positionAt(state,srvNow()));
      report('prepared',true); revision=-1;
      if(state.playing)apply(state);
      return;
    }
    preparedRevision = state.revision; preparing = true; playedForPreparation = false;
    clearTimeout(preparationTimeout); clearTimeout(preparationPoll); cancel(); pause(); mute(true);
    seek(WaveSync.positionAt(state, srvNow()));
    report('loading', true);
    preparationTimeout = setTimeout(() => {
      if (!preparing) return;
      preparing = false; clearTimeout(preparationPoll); pause(); report('error');
      G(side() + '-enable').hidden = false;
      G(side() + '-device-status').textContent = 'Audio preparation stalled. Tap Enable Audio to retry.';
      preparedRevision = -1;
    }, 20000);
    play();
    pollPreparation();
  }
  function pollPreparation() {
    clearTimeout(preparationPoll);
    if(!preparing)return;
    completePreparation();
    if(preparing)preparationPoll = setTimeout(pollPreparation, 25);
  }
  function completePreparation() {
    if (!preparing || !ready || !timeline || !ntpDone || disconnected) return;
    const observable = isYoutube() ? [1, 2].includes(player?.getPlayerState()) :
      audio().readyState >= 3 && !audio().seeking;
    if (!playedForPreparation || !observable) return;
    const target = WaveSync.positionAt(timeline, srvNow());
    const observed = mediaTime();
    // A Playing event can arrive while an asynchronous seek still shows the
    // old frames. Confirm the requested position before admitting this device.
    if (!Number.isFinite(observed) || Math.abs(observed - target) > 0.15) {
      if (performance.now() - lastSeek > 1000) seek(target);
      return;
    }
    preparing = false; clearTimeout(preparationTimeout); clearTimeout(preparationPoll);
    pause(); report('prepared', true);
    revision = -1;
    if (timeline.playing) apply(timeline);
  }
  function mediaStarted() {
    if(status === 'error' && !preparing){pause();mute(true);return;}
    const wasEnabled = enabled;
    enabled = true; audioAllowed = true;
    G(side() + '-enable').hidden = true;
    if (!amHost) G('unlock').classList.add('gone');
    if (preparing) {
      playedForPreparation = true;
      // Hold static targets while confirming the asynchronous seek. A slow
      // background callback must not miss a short moving-position window.
      if(!timeline?.playing)pause();
      completePreparation(); return;
    }
    if(timeline?.waiting){pause();mute(true);prepare(timeline);return;}
    report('ready');
    if (!timeline?.playing || srvNow() < timeline.serverPlayAt) { pause(); return; }
    mute(false);
    if (!wasEnabled) { revision = -1; apply(timeline); }
  }
  function api() {
    if (window.YT?.Player) return Promise.resolve(window.YT);
    if (!youtubePromise) {
      youtubePromise = new Promise((resolve, reject) => {
        const deadline = setTimeout(() => reject(new Error('YouTube player could not load. Check your connection or content blocker.')), 20000);
        window.onYouTubeIframeAPIReady = () => { clearTimeout(deadline); resolve(window.YT); };
        const script = document.createElement('script');
        script.src = 'https://www.youtube.com/iframe_api';
        script.onerror = () => { clearTimeout(deadline); reject(new Error('YouTube player could not load.')); };
        document.head.appendChild(script);
      }).catch(error => { youtubePromise = null; throw error; });
    }
    return youtubePromise;
  }
  async function load(next, retry = false) {
    if (!next || (!retry && next.id === track?.id)) return;
    const attempt = ++generation;
    loadAbort.abort(); loadAbort = new AbortController();
    clearTimeout(loadTimeout); clearTimeout(preparationTimeout); clearTimeout(preparationPoll);
    cancel();
    if(progRaf){cancelAnimationFrame(progRaf);progRaf=null;}
    if(vizRaf){cancelAnimationFrame(vizRaf);vizRaf=null;}
    if(!next.isScreenShare || !amHost)teardown(side());
    buffered?.dispose(); buffered=null;
    player?.destroy(); player = null;
    audio().pause();
    audio().oncanplay = audio().onloadedmetadata = audio().onerror = null;
    audio().removeAttribute('src'); audio().srcObject = null; audio().load();
    if (!next.isScreenShare || !amHost) stopScreenShare();
    Object.values(peerConns).forEach(pc => pc.close()); peerConns = {};
    track = next; currentTrack = next;
    timeline = null; revision = -1; preparedRevision = -1; preparing = false;
    ready = false; enabled = false; status = '';
    mute(false);
    G(side() + '-calibration').hidden = isYoutube() || !!next.isScreenShare;
    G(side() + '-youtube-wrap').hidden = !isYoutube();
    G(side() + '-spectrum').hidden = isYoutube();
    G('unlock').onclick = doUnlock;
    G('unlock').classList.add('gone');
    G(side() + '-enable').hidden = true;
    G(side() + '-tname').textContent = next.title;
    setPill(side() + '-pill', 'pw', 'dm', 'Loading');
    if(!amHost)setSyncInfo(isYoutube() ? 'YouTube plays on this device. Timing is approximate.' : 'Using the shared room timeline.');
    G(side() + '-art').classList.remove('spin');
    document.querySelectorAll('#s-' + (amHost ? 'host' : 'listen') + ' .eq-wrap').forEach(el => el.hidden = isYoutube());
    if (amHost) {
      G('h-player').style.display = 'block';
      if(!next.isScreenShare){G('h-live-badge').style.display='none';G('h-play-btn').style.display='';G('h-restart-btn').style.display='';}
      G('h-tsub').textContent = isYoutube() ? 'YouTube · plays on each device · no API key' : 'Room audio';
    }
    if (next.isScreenShare) {
      // Host capture has already been created by startScreenShare().
      return;
    }
    report('loading');
    if (isYoutube()) {
      try {
        const YT = await api();
        if (attempt !== generation) return;
        const mount = G(side() + '-youtube');
        mount.replaceChildren();
        const child = document.createElement('div'); mount.appendChild(child);
        loadTimeout = setTimeout(() => {
          if(attempt !== generation || ready)return;
          report('error'); G(side() + '-enable').hidden = false;
          G(side() + '-device-status').textContent = 'YouTube did not become ready. Tap Enable Audio to retry or try another video.';
        }, 20000);
        player = new YT.Player(child, {
          width: '100%', height: '240', videoId: next.videoId,
          playerVars: { playsinline: 1, controls: 0, disablekb: 1, origin: location.origin },
          events: {
            onReady: event => {
              if (attempt !== generation) return;
              clearTimeout(loadTimeout); ready = true;
              const title = event.target.getVideoData()?.title;
              if(title)G(side() + '-tname').textContent = title;
              event.target.setVolume(Number(G(side() + '-vol').value) * 100);
              if(audioAllowed){enabled = true;prepare(timeline);}else needsGesture();
            },
            onAutoplayBlocked: () => { if (attempt === generation) needsGesture(); },
            onError: event => {
              if (attempt !== generation) return;
              ready = false; preparing = false; clearTimeout(preparationTimeout); clearTimeout(preparationPoll); cancel(); report('error');
              G(side() + '-enable').hidden = false;
              G(side() + '-device-status').textContent = 'YouTube cannot play this video (' + event.data + '). Retry or try a public video that permits embedding.';
            },
            onStateChange: event => {
              if (attempt !== generation) return;
              if (event.data === YT.PlayerState.PLAYING) mediaStarted();
              else if (event.data === YT.PlayerState.BUFFERING && enabled) report('buffering');
              else if (event.data === YT.PlayerState.ENDED && amHost && timeline?.playing) command('pause', duration());
            }
          }
        });
      } catch (error) {
        if (attempt !== generation) return;
        report('error'); G(side() + '-device-status').textContent = error.message;
      }
    } else {
      let downloadTimeout;
      try {
        buildChain(audio(),side());
        const context=amHost?hCtx:lCtx;
        const eq=amHost?hEQ:lEQ;
        if(!context || !eq)throw new Error('Web Audio is unavailable on this browser');
        const engine=new BufferedRoomAudio(context,eq.sub,()=>{
          if(attempt===generation && amHost && timeline?.playing)command('pause',duration());
        });
        buffered=engine;
        try{
          const saved=localStorage.getItem('waveroom.advanceMs');
          if(saved!==null && Number.isFinite(Number(saved)))G(side()+'-advance').value=String(Math.max(-1000,Math.min(1000,Number(saved))));
        }catch(_){}
        engine.advanceMs=Math.max(-1000,Math.min(1000,Number(G(side()+'-advance').value)||0));
        report('loading');
        // Capture this load's controller; its timeout must never abort a newer track.
        const downloadController=loadAbort;
        downloadTimeout=setTimeout(()=>downloadController.abort(),90000);
        const response=await fetch(next.streamUrl,{signal:downloadController.signal});
        if(!response.ok)throw new Error('Audio download failed ('+response.status+')');
        if(Number(response.headers.get('content-length'))>25*1024*1024)throw new Error('Audio must be 25 MB or smaller');
        const reader=response.body.getReader(); let bytes=0; const chunks=[];
        for(;;){
          const part=await reader.read(); if(part.done)break;
          bytes+=part.value.byteLength;
          if(bytes>25*1024*1024){await reader.cancel();throw new Error('Audio must be 25 MB or smaller');}
          chunks.push(part.value);
        }
        const data=new Uint8Array(bytes);let offset=0;
        for(const chunk of chunks){data.set(chunk,offset);offset+=chunk.byteLength;}
        const decoded=await context.decodeAudioData(data.buffer);
        if(attempt!==generation)return;
        if(decoded.duration>600)throw new Error('Choose audio under 10 minutes');
        engine.buffer=decoded; ready=true;
        G(side()+'-dur').textContent=fmt(engine.duration);
        startViz(side()+'-viz',amHost?hAn:lAn);
        if(audioAllowed){enabled=true;enable();}else needsGesture();
      } catch(error) {
        if(attempt!==generation)return;
        ready=false; report('error');
        G(side()+'-enable').hidden=false;
        G(side()+'-device-status').textContent=error.message+' — tap Enable Audio to retry.';
      } finally { clearTimeout(downloadTimeout); }
    }
  }

  function apply(state) {
    timeline = state;
    if(status === 'error')return;
    if (!ready || !enabled || !ntpDone || disconnected || !state) return;
    if (state.revision === revision) return;
    revision = state.revision;
    if(state.waiting){prepare(state);return;}
    if(buffered){
      preparing=false; cancel(); buffered.stop(state.position);
      if(!state.playing)return;
      try{buffered.schedule(state,srvNow());}
      catch(_){needsGesture();return;}
      timer=setTimeout(()=>{
        if(!disconnected && timeline?.playing && buffered?.source)report('ready',true);
      },Math.max(0,state.serverPlayAt-srvNow()));
      return;
    }
    preparing = false; clearTimeout(preparationTimeout); clearTimeout(preparationPoll);
    cancel(); pause();
    if (isYoutube()) player.setPlaybackRate(1); else audio().playbackRate = 1;
    const target = WaveSync.positionAt(state, srvNow());
    if(Math.abs(mediaTime() - target) > 0.05)seek(target);
    if (!state.playing) { mute(false); return; }
    const start = () => {
      if (disconnected || !timeline?.playing) return;
      const target = WaveSync.positionAt(timeline, srvNow());
      if(Math.abs(mediaTime() - target) > 0.10)seek(target);
      // The prepared player is paused until this shared deadline. Enable
      // sound before play so audio does not wait for a later iframe callback.
      mute(false);
      play();
    };
    timer = setTimeout(start, Math.max(0, state.serverPlayAt - srvNow()));
  }
  function correct() {
    if (track?.isScreenShare || !ready || !enabled || !timeline || !ntpDone || disconnected) return;
    if(status === 'error')return;
    if(buffered && buffered.context.state!=='running'){needsGesture();return;}
    if (preparing) { completePreparation(); return; }
    if (revision !== timeline.revision) { apply(timeline); return; }
    if (timeline.waiting) { if(!preparing && preparedRevision !== timeline.revision)prepare(timeline); return; }
    if (!timeline.playing || srvNow() < timeline.serverPlayAt) return;
    if(status === 'buffering' && performance.now() - lastBufferReport > 1000){
      lastBufferReport = performance.now(); report('buffering', true);
    }
    const target = WaveSync.positionAt(timeline, srvNow());
    const drift = mediaTime() - target;
    if(buffered){
      if(buffered.correct(target)==='resync'){
        buffered.stop(); report('buffering',true);
        return;
      }
      G(side()+'-timing').textContent='Estimated timeline difference: '+Math.round(drift*1000)+' ms';
      return;
    }
    const threshold = isYoutube() ? 0.30 : 0.25;
    if (Math.abs(drift) > threshold && performance.now() - lastSeek > 2500) seek(target);
    else if (!isYoutube()) audio().playbackRate = Math.abs(drift) > 0.025 ? (drift > 0 ? 0.98 : 1.02) : 1;
    if (isYoutube()) {
      if ([2, 5, -1].includes(player.getPlayerState())) play();
    } else if (audio().paused && !audio().ended) play();
    const label = 'Timeline difference: ' + Math.round(drift * 1000) + ' ms · ' + status;
    G(side() + '-timing').textContent = label;
  }
  function enable() {
    if (track && !track.isScreenShare && status === 'error') {
      // Recreate a failed player or retry downloading the shared file.
      // Keep the latest room timeline while the device prepares again.
      const state = timeline;
      audioAllowed = true;
      load(track, true);
      apply(state);
      return;
    }
    if (!ready) { toast('Wait for the player to load'); return; }
    if(buffered){
      const attempt=generation, engine=buffered;
      engine.context.resume().then(()=>{
        if(attempt!==generation || disconnected)return;
        enabled=true; audioAllowed=true; preparedRevision=-1;
        G(side()+'-enable').hidden=true; G('unlock').classList.add('gone');
        prepare(timeline);
      }).catch(()=>{if(attempt===generation)needsGesture();});
      return;
    }
    const context = amHost ? hCtx : lCtx;
    if (context?.state === 'suspended') context.resume().catch(() => {});
    preparedRevision = -1;
    prepare(timeline);
  }
  function command(action, position = timeline ? WaveSync.positionAt(timeline, srvNow()) : mediaTime()) {
    if (!track || !sock?.connected) { toast('Connect and load a track first'); return; }
    sock.emit('playback:command', { action, position, trackId: track.id }, result => {
      if (!result?.ok) toast(result?.error || 'Playback command failed', 5000);
      else if(result.queued)toast('Play queued — enable audio on each joining device.', 5000);
    });
  }
  function devices(data) {
    if (!amHost) return;
    const entries = Object.entries(data);
    const count = entries.filter(([, device]) => device.ready).length;
    G('h-room-status').textContent = count + '/' + entries.length + ' devices ready' +
      (timeline?.waiting ? ' · waiting to play together' : '');
    const list = G('h-llist');
    list.replaceChildren();
    for (const [id, device] of entries) {
      const row = document.createElement('div'); row.className = 'l-item';
      row.textContent = (id === sock.id ? 'This device' : 'Listener') + ' · ' + device.status;
      list.appendChild(row);
    }
  }
  function snapshot(data) {
    if (data.track?.id !== track?.id) load(data.track);
    // load() establishes track synchronously before awaiting the iframe API.
    timeline = data.state;
    devices(data.devices || {});
    apply(timeline);
  }
  function bind() {
    sock.on('room:state', snapshot);
    sock.on('room:devices', devices);
    sock.on('disconnect', () => { disconnected = true; cancel(); pause(); });
    sock.on('connect', () => {
      disconnected = false;
      if (!roomCode || resuming) return;
      resuming = true;
      sock.emit('room:join', { code: roomCode, ...(amHost ? { hostToken: roomHostToken } : {}) }, result => {
        resuming = false;
        if (!result?.ok) { toast(result?.error || 'Room could not resume'); leave(); return; }
        listeners = Object.fromEntries((result.listeners || []).map(id => [id, true]));
        revision = -1; status = '';
        snapshot(result);
        if (track && ready && !track.isScreenShare) {
          if(enabled)prepare(timeline); else needsGesture();
        }
        if (amHost && screenStream) Object.keys(listeners).forEach(id => createOffer(id));
        toast('Room reconnected');
      });
    });
  }
  function reset() {
    cancel(); clearTimeout(loadTimeout); clearTimeout(preparationTimeout); clearTimeout(preparationPoll); loadAbort.abort(); ++generation; player?.destroy(); player = null;
    buffered?.dispose(); buffered=null;
    track = timeline = null; currentTrack = null;
    audioAllowed = false;
    ready = enabled = preparing = false; status = ''; revision = preparedRevision = -1;
    disconnected = false; resuming = false;
    ['h', 'l'].forEach(prefix => {
      G(prefix + '-youtube-wrap').hidden = true;
      G(prefix + '-enable').hidden = true;
      G(prefix + '-timing').textContent = '';
    });
  }
  setInterval(() => {
    correct();
    if (!track || !ready) return;
    const prefix = side(), length = duration(), time = mediaTime();
    G(prefix + '-cur').textContent = fmt(time);
    G(prefix + '-dur').textContent = fmt(length);
    G(prefix + '-fill').style.width = (length ? Math.min(100, time / length * 100) : 0) + '%';
    G(prefix + '-art').classList.toggle('spin', !!timeline?.playing);
    setPill(prefix + '-pill', timeline?.playing ? 'pl' : 'pw', timeline?.playing ? 'dg' : 'dm',
      timeline?.waiting ? 'Preparing room' : timeline?.playing ? (status === 'ready' ? 'Playing' : status === 'prepared' ? 'Starting' : status) : 'Paused');
  }, 250);
  return { bind, load, snapshot, enable, reset, command, duration, isYoutube, compensation,
    clockLost: () => {
      if(track && enabled && !track.isScreenShare){cancel();pause();report('buffering',true);}
    },
    calibrate: value => {
      if(!buffered)return;
      buffered.advanceMs=Math.max(-1000,Math.min(1000,Number(value)||0));
      try{localStorage.setItem('waveroom.advanceMs',String(buffered.advanceMs));}catch(_){}
      G(side()+'-advance').value=String(buffered.advanceMs);
      if(timeline?.playing){revision=-1;apply(timeline);}
    },
    volume: value => { if (isYoutube()) player?.setVolume(value * 100); },
    seek: ratio => command('seek', ratio * duration()) };
})();
