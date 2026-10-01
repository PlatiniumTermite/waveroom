(function(root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BufferedRoomAudio = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  'use strict';
  class BufferedRoomAudio {
    constructor(context, destination, onended = () => {}, performanceNow = () => performance.now()) {
      this.context = context; this.destination = destination; this.onended = onended; this.performanceNow = performanceNow;
      this.buffer = null; this.source = null; this.offset = 0;
      this.anchor = 0; this.startPosition = 0; this.rate = 1; this.advanceMs = 0;
    }
    get latency() {
      const value = this.context.outputLatency;
      return Number.isFinite(value) && value >= 0 && value <= 0.1 ? value : 0;
    }
    get outputTime() {
      // Bridge the output-device clock to performance.now(), as in BeatSync.
      // This already accounts for output delay: do not subtract it twice.
      try {
        const timestamp=this.context.getOutputTimestamp?.();
        const now=this.performanceNow();
        if(timestamp && Number.isFinite(timestamp.contextTime) && timestamp.contextTime>0 &&
          Number.isFinite(timestamp.performanceTime) && timestamp.performanceTime>0 &&
          now>=timestamp.performanceTime && now-timestamp.performanceTime<1000){
          const time=timestamp.contextTime+(now-timestamp.performanceTime)/1000;
          if(time<=this.context.currentTime+0.02 && this.context.currentTime-time<=1)return time;
        }
      } catch (_) { /* Older engines can lack a usable output timestamp. */ }
      return this.context.currentTime-this.latency;
    }
    get outputDelay() { return Math.max(0,this.context.currentTime-this.outputTime); }
    get duration() { return this.buffer?.duration || 0; }
    get position() {
      if (!this.source) return this.offset;
      return Math.min(this.duration, Math.max(this.startPosition, this.offset +
        (this.outputTime - this.anchor) * this.rate));
    }
    stop(position = this.position) {
      if (this.source) { this.source.onended = null; this.source.stop(); this.source.disconnect(); }
      this.source = null; this.offset = Math.max(0, Math.min(position, this.duration));
    }
    schedule(state, now) {
      this.stop();
      if (!this.buffer || this.context.state !== 'running') throw new Error('Enable audio on this device');
      // Schedule ahead on the audio thread; main-thread timers only update UI.
      const outputTime=this.outputTime;
      const compensation = Math.max(0,this.context.currentTime-outputTime) + this.advanceMs / 1000;
      const arrival = Math.max(state.serverPlayAt, now + 120 + Math.max(0, compensation) * 1000);
      const offset = state.position + Math.max(0, arrival - state.serverPlayAt) / 1000;
      if (offset >= this.duration) { this.offset = this.duration; this.onended(); return; }
      const when = outputTime + (arrival - now) / 1000 - this.advanceMs / 1000;
      const source = this.context.createBufferSource();
      source.buffer = this.buffer; source.connect(this.destination);
      this.source = source; this.anchor = when; this.startPosition = offset; this.offset = offset; this.rate = 1;
      source.onended = () => {
        if (this.source !== source) return;
        source.disconnect(); this.source = null; this.offset = this.duration; this.onended();
      };
      source.start(when, offset);
    }
    correct(target) {
      if (!this.source || this.outputTime < this.anchor) return;
      const drift = this.position - target - this.advanceMs / 1000;
      if (Math.abs(drift) > 0.1) return 'resync';
      const rate = Math.abs(drift) > 0.008 ? (drift > 0 ? 0.997 : 1.003) : 1;
      if (rate !== this.rate) {
        // Keep the position estimate continuous on the output clock.
        // The AudioParam change still belongs to the processing clock.
        const outputTime=this.outputTime;
        this.offset += (outputTime - this.anchor) * this.rate;
        this.anchor = outputTime;
        this.rate = rate; this.source.playbackRate.setValueAtTime(rate, this.context.currentTime);
      }
    }
    dispose() { this.stop(); this.buffer = null; }
  }
  return BufferedRoomAudio;
});
