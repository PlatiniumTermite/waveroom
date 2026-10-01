# WaveRoom

Create a room and play YouTube links or uploaded audio together on multiple devices. YouTube playback uses the official IFrame Player API on each device; no YouTube API key or server audio extraction is needed.

## Run

Requires Node.js 18 or later.

```sh
npm ci
npm start
```

Open `http://localhost:3000`. For phones, use the host computer's address on the same network or a deployed HTTPS address. `PORT` changes the server port. `/health` reports readiness. Rooms, timelines, and uploads live in memory: use one server instance, and expect rooms to end when it restarts. Render's free instance may sleep; the first visit can take time to load.

## Play together

1. Create a room and share its six character code.
2. Join from the other phones or computers.
3. Paste a YouTube video link in **YouTube / URL**, paste a direct audio URL, or upload an audio file (up to 25 MB).
4. YouTube links queue playback automatically. For uploaded files and direct audio URLs, press Play once.
5. Press **Enable Audio on This Device** on each device when prompted. The room starts together once all devices are ready. Later tracks reuse the audio permission where the browser allows it. Pause, restart, and seek apply to the entire room.

The host and listeners use the same server timestamp and track revision. Playback starts 1.5 seconds after every device confirms preparation of the requested position. Play, Restart, and a seek during playback each require fresh preparation; readiness from a previous position cannot release a new start. New listeners catch up to the current timeline without reloading other devices. Browser clocks use a monotonic timer, are measured periodically, and drift is corrected during playback. If an active speaker buffers or loses audio permission after playback starts, the room pauses at a shared position, prepares the devices quietly, and resumes them together. A short room pause can occur during recovery. If preparation stalls for 20 seconds, the device shows a retry button; retry recreates a failed YouTube player and prepares the latest room position. A late joiner prepares independently; its initial loading does not pause existing speakers. Pause cancels a queued start or recovery. Brief network disconnects automatically rejoin; the host has a 20 second grace period. Reopening a page does not restore host ownership.

### Synchronization limits

YouTube embeds buffer separately on each device. Ads, network stalls, autoplay restrictions, unavailable or embedding disabled videos, browser scheduling, and speaker or Bluetooth output latency can cause audible differences. The displayed timeline difference measures player position, not sound arriving at your ears. Preparation confirms reported player position within 150 ms of its target before acknowledging readiness; that tolerance is not a guarantee of acoustic alignment. **This is approximate synchronized playback, not sample accurate playback or Dolby Atmos.** Keep pages in the foreground and use device speakers for the most predictable timing. YouTube EQ is unavailable because the embedded player does not expose its audio to Web Audio.

Direct audio permits finer playback rate adjustments than YouTube. Uploaded files are shared by the server with seeking support; one uploaded file per room is retained, and all files are removed when their rooms end. Total uploaded storage is limited to 100 MB per server. There is no built in music catalog.

Screen / Tab mode uses browser tab capture and WebRTC. Select a tab and enable sharing its audio (desktop Chrome/Edge). Its network and output delays differ per device; it does not use the scheduled media timeline. Control playback in the source tab.

## Verify

```sh
npm test
```

Tests cover queued starts, coordinated buffering recovery, stale readiness, departure during preparation, quiet device preparation, room scheduling, late joins, playback authorization, paused seeks, stale commands, host reconnection, YouTube URL parsing, upload authorization, and seek ranges. Real multi-device acoustic timing still requires testing on physical hardware.
