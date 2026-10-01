(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.WaveSync = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  function youtubeId(value) {
    try {
      const url = new URL(value);
      if (!['https:', 'http:'].includes(url.protocol)) return null;
      const host = url.hostname.toLowerCase();
      let id;
      if (host === 'youtu.be') id = url.pathname.split('/')[1];
      else if (['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com'].includes(host)) {
        id = url.pathname === '/watch' ? url.searchParams.get('v') :
          /^\/(embed|shorts|live)\//.test(url.pathname) ? url.pathname.split('/')[2] : null;
      }
      return /^[A-Za-z0-9_-]{11}$/.test(id || '') ? id : null;
    } catch (_) { return null; }
  }
  function positionAt(state, now) {
    return Math.max(0, state.position + (state.playing ? Math.max(0, now - state.serverPlayAt) / 1000 : 0));
  }
  function validPosition(value) { return Number.isFinite(value) && value >= 0 && value <= 86400 * 7; }
  return { youtubeId, positionAt, validPosition };
});
