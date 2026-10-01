# BeatSync synchronization attribution

WaveRoom's paired NTP probes, gap filtering, minimum-RTT clock selection and adaptive scheduling are adapted from freeman-jiang/beatsync, inspected at commit 94c38ab16ec861835ce0b4bc3a7db82dabbb9b88:

- https://github.com/freeman-jiang/beatsync/blob/94c38ab16ec861835ce0b4bc3a7db82dabbb9b88/apps/client/src/utils/ntp.ts
- https://github.com/freeman-jiang/beatsync/blob/94c38ab16ec861835ce0b4bc3a7db82dabbb9b88/apps/server/src/config.ts
- https://github.com/freeman-jiang/beatsync/blob/94c38ab16ec861835ce0b4bc3a7db82dabbb9b88/apps/client/src/lib/audioContextManager.ts

The MIT license is retained in beatsync-LICENSE.txt. WaveRoom integrates these techniques with its own Socket.IO protocol, readiness barriers, shared audio downloads and recovery controls.
