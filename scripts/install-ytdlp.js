'use strict';
// Pin and verify the official self-contained Linux release. No Python or API key.
const { mkdir, writeFile, rename, readFile, chmod } = require('node:fs/promises');
const { createHash } = require('node:crypto');
const path = require('node:path');
const digest = '58162f9bfdc27458ea47bfcb311cf47028f17d8154a8bf7d689861d46399230a';
const destination = path.join(__dirname, '..', '.tools', 'yt-dlp');
async function install() {
  if (process.env.YT_DLP_PATH) return; // Operator-provided executable.
  if (process.platform !== 'linux' || process.arch !== 'x64') {
    throw new Error('Set YT_DLP_PATH to a local yt-dlp executable on this platform.');
  }
  try {
    const existing = await readFile(destination);
    if (createHash('sha256').update(existing).digest('hex') === digest) { await chmod(destination, 0o700); return; }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const response = await fetch('https://github.com/yt-dlp/yt-dlp/releases/download/2026.08.19/yt-dlp_linux', {
    signal: AbortSignal.timeout(120000)
  });
  if (!response.ok) throw new Error(`yt-dlp download failed (${response.status})`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (createHash('sha256').update(bytes).digest('hex') !== digest) throw new Error('yt-dlp checksum mismatch');
  await mkdir(path.dirname(destination), { recursive: true });
  const temporary = destination + '.' + process.pid;
  await writeFile(temporary, bytes, { mode: 0o700 });
  await rename(temporary, destination);
}
install().catch(error => { console.error(error.message); process.exitCode = 1; });
