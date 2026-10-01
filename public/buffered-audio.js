(function(root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BufferedRoomAudio = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  'use strict';
  class BufferedRoomAudio {
    constructor(context, destination, onended = () => {}) {
      this.context = context; this.destination = destination; this.onended = onended;
      this.buffer = null; this.source = null; this.offset = 0;
      this.anchor = 0; this.startPosition = 0; this.rate = 1; this.advanceMs = 0;
    }
    get latency() {
      const value = this.context.outputLatency;
      return Number.isFinite(value) && value >= 0 && value <= 1 ? value : 0;
    }
    get duration() { return this.buffer?.duration || 0; }
    get position() {
      if (!this.source) return this.offset;
      return Math.min(this.duration, Math.max(this.startPosition, this.offset +
        (this.context.currentTime - this.latency - this.anchor) * this.rate));
    }
    stop(position = this.position) {
      if (this.source) { this.source.onended = null; this.source.stop(); this.source.disconnect(); }
      this.source = null; this.offset = Math.max(0, Math.min(position, this.duration));
    }
    schedule(state, now) {
      this.stop();
      if (!this.buffer || this.context.state !== 'running') throw new Error('Enable audio on this device');
      // Schedule ahead on the audio thread; main-thread timers only update UI.
      const compensation = this.latency + this.advanceMs / 1000;
      const arrival = Math.max(state.serverPlayAt, now + 120 + Math.max(0, compensation) * 1000);
      const offset = state.position + Math.max(0, arrival - state.serverPlayAt) / 1000;
      if (offset >= this.duration) { this.offset = this.duration; this.onended(); return; }
      const when = this.context.currentTime + (arrival - now) / 1000 - compensation;
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
      if (!this.source || this.context.currentTime < this.anchor + this.latency) return;
      const drift = this.position - target - this.advanceMs / 1000;
      const rate = Math.abs(drift) > 0.008 ? (drift > 0 ? 0.997 : 1.003) : 1;
      if (rate !== this.rate) {
        // Preserve the render position while changing the clock slope.
        this.offset += (this.context.currentTime - this.anchor) * this.rate;
        this.anchor = this.context.currentTime;
        this.rate = rate; this.source.playbackRate.setValueAtTime(rate, this.anchor);
      }
    }
    dispose() { this.stop(); this.buffer = null; }
  }
  return BufferedRoomAudio;
});
