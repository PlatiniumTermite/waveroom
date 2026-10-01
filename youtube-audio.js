'use strict';
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { mkdtemp, readFile, rm, stat } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const run = promisify(execFile);

async function resolveYoutube(videoId, { executable = process.env.YT_DLP_PATH || path.join(__dirname, '.tools', 'yt-dlp') } = {}) {
  if (!/^[\w-]{11}$/.test(videoId)) throw new Error('Invalid YouTube video');
  const directory = await mkdtemp(path.join(tmpdir(), 'waveroom-youtube-'));
  try {
    const output = path.join(directory, 'audio.m4a');
    await run(executable, [
      '--ignore-config', '--no-playlist', '--no-progress', '--no-warnings',
      '--js-runtimes', 'node:' + process.execPath,
      '--socket-timeout', '15', '--retries', '1', '--extractor-retries', '1',
      '--match-filters', '!is_live & duration <= 600', '--max-filesize', '25M',
      '--format', 'bestaudio[ext=m4a]', '--fixup', 'never',
      '--write-info-json', '--output', output,
      'https://www.youtube.com/watch?v=' + videoId
    ], { timeout: 180000, killSignal: 'SIGKILL', maxBuffer: 512 * 1024, windowsHide: true });
    const info = JSON.parse(await readFile(path.join(directory, 'audio.info.json'), 'utf8'));
    if (info.is_live || !Number.isFinite(info.duration) || info.duration <= 0 || info.duration > 600) {
      throw new Error('Unsupported duration');
    }
    const file = await stat(output);
    if (!file.size || file.size > 25 * 1024 * 1024) throw new Error('Unsupported audio size');
    const mp3 = path.join(directory, 'shared.mp3');
    const ffmpeg = process.env.FFMPEG_PATH || require('ffmpeg-static');
    if (!ffmpeg) throw new Error('Audio converter unavailable');
    await run(ffmpeg, ['-nostdin', '-v', 'error', '-i', output, '-vn', '-ac', '2', '-ar', '48000',
      '-codec:a', 'libmp3lame', '-b:a', '192k', '-t', '600', mp3],
      { timeout: 60000, killSignal: 'SIGKILL', maxBuffer: 128 * 1024 });
    return { buffer: await readFile(mp3), type: 'audio/mpeg', title: String(info.title || 'YouTube audio').slice(0, 200) };
  } catch (error) {
    if (error.code === 'ENOENT' && error.path === executable) {
      throw new Error('YouTube audio preparation is unavailable on this server. Run npm run setup:youtube.');
    }
    throw new Error('Could not prepare this YouTube video. Use a public, non-live video under 10 minutes, or upload its audio file. YouTube may also block server downloads.');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
module.exports = { resolveYoutube };
