# WaveRoom

Paste a YouTube link, create or join a room, and play the same audio together. Shared audio mode downloads one file for the room, converts it to MP3, and buffers it on each device before scheduling playback on the browser's audio clock. No YouTube API key, user cookies, or music-provider account is required.

## Run

Requires Node.js 22 or later (tested with 24.14.1).

```sh
npm ci
npm run setup:youtube
npm start
```

Open `http://localhost:3000`. Phones need the host computer's address on the same network or a deployed HTTPS address. `PORT` changes the server port; `/health` reports readiness.

`setup:youtube` installs the checksum-verified official yt-dlp 2026.08.19 executable on Linux x64. On other platforms, install yt-dlp and set `YT_DLP_PATH` to its executable. Audio conversion uses the pinned `ffmpeg-static` dependency, or an operator-provided `FFMPEG_PATH`. The Render build runs installation and YouTube setup automatically. GitHub downloads must be reachable during setup.

Rooms and audio files live in memory. Use one server instance; restarting it ends rooms and removes their audio. Render free instances may sleep between visits.

## Play together

1. Create a room and share its six character code.
2. Join on your other devices.
3. Paste a public YouTube video link. **Shared audio** is the default; preparation can take a minute. This mode plays a shared audio file inside WaveRoom, rather than a YouTube video on each device.
4. Tap **Enable Audio on This Device** when prompted. Playback queues automatically and starts once every device has downloaded and decoded the audio and enabled sound.
5. Pause, Restart, and Seek control the room. New listeners download the same file and catch up without restarting existing speakers.

You can also upload an audio file or paste a direct audio URL. For those sources, press Play once. All shared audio must be under 10 minutes and 25 MB. The server retains one audio file per room, with a combined storage limit of 100 MB and at most two concurrent YouTube preparations. Direct URLs must provide a finite audio file, not a live stream.

### Timing

Devices periodically measure their clock difference from the server. Each decoded audio buffer is scheduled in advance with `AudioBufferSourceNode.start`, so a delayed JavaScript UI timer does not determine its actual start. Browser-reported output latency is compensated, and small clock differences are corrected with gentle playback-rate changes.

If speakers still sound misaligned, use **Device timing adjustment** on that device: positive values play earlier and negative values play later. These values apply to shared audio and remain while you use the page. Device and Bluetooth latency reporting varies, so the displayed timeline difference is an estimate, not a microphone measurement. Physical speaker alignment and every phone/browser combination have not been verified; keep the page active for predictable playback. This is not Dolby Atmos.

Play, Restart, and playing Seek require fresh readiness for the requested position. A device losing audio permission can pause the room while devices prepare again. Pause cancels a queued start. Brief network interruptions automatically rejoin; host ownership has a 20 second reconnect grace period and is not restored by a page reload.

### YouTube availability

A successful download is not guaranteed for every video or hosting network. Private, restricted, unavailable, live, or longer videos are unsupported; YouTube may block downloads or change its player, requiring an extractor update. Errors are shown without silently switching playback mode. The public-video download and two-device flow have been tested locally; Render's network has not been verified because deployment access is unavailable.

The **YouTube player** option keeps playback in official embedded players without an API key. Those players buffer independently and provide approximate timing. Their audio is unavailable to WaveRoom's equalizer and decoded-buffer scheduler. Shared audio mode supports volume, EQ, and the existing spatial preset.

Screen / Tab mode captures desktop browser tab audio over WebRTC. Select a tab and enable audio sharing. It is a separate live mode with per-device network delays; it does not use decoded-buffer scheduling. Control playback in the source tab. No built-in music library is included.

## Verify

```sh
npm test
```

Tests cover audio-clock scheduling, latency compensation, calibration, cancellation, decoding/readiness, clock correction, shared starts, recovery, late joining, authorization, upload ranges, and YouTube preparation ownership/concurrency. Real source downloads depend on YouTube and are checked separately from deterministic tests.
