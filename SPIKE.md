# Lucifer voice spike — result

**Date:** 2026-11-07
**Question:** how does Cloudflare-served audio get into Discord's voice session?
**Harness:** `npm test` (`spike/run-spike.js`) — **36/36 checks pass.**
**Live Discord proof:** NOT done — no bot token, application, server, or voice
channel exists yet. Nothing in this document claims the voice leg works
against live Discord. It proves the protocol code against mocks.

## Verdict

**The command plane works on Cloudflare. The voice leg does NOT work on
pure Cloudflare — and the reason is a documented platform gap, not a bug in
this code: the Workers runtime has no outbound UDP sockets.**

Discord voice audio is UDP. A Worker (or Durable Object) cannot open a UDP
socket, so it cannot send a single Opus packet to Discord's voice server,
and it cannot perform the UDP IP-discovery step that Select Protocol
requires. This was the spike's central finding, and it is reported here
with the evidence instead of being worked around silently or replaced
unilaterally. The architecture is NOT being replaced: everything a Worker
can do stays on Cloudflare, and the one thing it cannot do goes to a
minimal relay (below). Gary decides whether that trade is acceptable.

### Evidence for the gap

1. **Workers runtime: `cloudflare:sockets` `connect()` is TCP-only.** The
   Workers docs list no UDP API anywhere; independent research (2026-07-26
   phase-0 report, verified against primary sources) states: "the
   Workers/Pages runtime has no outbound UDP and no datagram API of any
   kind." No Durable Object UDP story exists either — Durable Objects can
   hold WebSockets and TCP sockets, not UDP.
2. **Discord's own voice docs require UDP.** Voice connections use "a
   separate UDP-based connection for RTC data transmission" and the client
   "must be able to receive UDP packets, even through a firewall or NAT."
   Audio is Opus 48 kHz stereo, 20 ms frames, RTP + SRTP encryption.
   IP discovery is itself a UDP exchange (74-byte request/response).
3. **No Worker-based Discord music bot exists in the wild.** The search
   found Worker bots that do text, slash commands, and voice *messages*
   (pre-recorded audio files sent over REST) — never live voice-channel
   audio. Every real music bot runs on a server/container with UDP
   (discord.js + @discordjs/voice, Lavalink, or a custom voice engine).
4. **Verified in this environment:** a real `dgram.send` to 127.0.0.1 in
   this VM returns `EPERM` (both Node and Python). The harness probes this
   and records it, then runs the voice leg over a virtual UDP transport
   (see "What the harness proves").

### The two candidate paths, assessed

| Path | Verdict |
|---|---|
| **A. Pure Worker/DO voice (UDP from the DO)** | **Blocked.** No UDP sockets in the runtime. Not a matter of trying harder — the API does not exist. |
| **B. Discord WebRTC transport via Cloudflare Realtime/Calls** | **Unproven, not recommended as the primary path.** Discord's docs do offer WebRTC as an alternative to UDP ("If you cannot support a UDP connection, you may implement a WebRTC connection instead"). But a Worker has no `RTCPeerConnection`, no DTLS/ICE stack, and Cloudflare Realtime is a managed SFU for browser/app clients — there is no API to make the SFU originate a WebRTC session to Discord's voice server as a peer, and Discord's voice WebRTC uses its own signalling (SDP exchanged via Select Protocol) plus its own encryption (DAVE/MLS migration). Bridging standard WebRTC to Discord's voice server is a research project of its own, with no documented precedent. Kept as a future investigation, not the v1 path. |
| **C. Minimal UDP relay (chosen for v1, pending Gary's call)** | **Works in code (see below).** The DO keeps the gateway WebSocket, the voice gateway WebSocket, queue state, and speaking signals. A ~250-line relay process (`spike/relay.js`) owns one UDP socket: it performs IP discovery, receives finished RTP packets from the DO over a WebSocket, and forwards them to Discord. It holds no credentials, no music library, and no queue — the secret key and the audio both arrive per-session from the DO. It can run on the same host that already runs the radio FFmpeg pass (the `docker-compose` `radio` service host), so it is not a second bot server — it is the smallest possible shim for the one syscall Workers cannot do. |

## What the harness proves (36/36)

Run it: `npm test`. All checks run against in-process mocks — mock Discord
gateway, mock voice gateway, mock voice UDP endpoint, mock radio Worker.
Real Opus audio is generated with ffmpeg (440 Hz sine, 48 kHz stereo) and
parsed out of its Ogg container, so the bytes that flow are genuine Opus
frames, not filler.

1. **Ed25519 verification (4 checks):** a real generated keypair signs an
   interaction; valid signature verifies, tampered signature / wrong
   timestamp / malformed key are all rejected. (WebCrypto, no dependency.)
2. **Radio contract client (5 checks):** `GET /radio/status` returns the
   `get_status()` shape; submissions list first in `upNext`; unconfigured
   endpoint degrades gracefully instead of crashing.
3. **Gateway signalling (5 checks):** Hello → Identify → READY → heartbeat
   ACK → Voice State Update (op 4) → VOICE_STATE_UPDATE +
   VOICE_SERVER_UPDATE with endpoint + token; the bot's voice channel is
   tracked from cached voice states.
4. **Voice signalling (5 checks):** voice Hello → Identify (carrying
   `max_dave_protocol_version: 0`) → Ready offering
   `aead_aes256_gcm_rtpsize` → UDP IP discovery answered → Select Protocol
   (`udp` + `aead_aes256_gcm_rtpsize`) → Session Description with a
   32-byte secret key → state `connected`.
5. **Audio path (6 checks):** Speaking (op 5) sent before audio; 10 Opus
   frames + 5 silence frames arrive over UDP; every packet decrypts with
   the session key to exactly the frame that was sent (AES-256-GCM
   round-trip); RTP sequence +1 per packet; RTP timestamp +960 (20 ms @
   48 kHz) per packet; 10 frames paced at ~20 ms each (223 ms measured).
6. **Relay hop (4 checks):** relay announces itself (HELLO + capabilities)
   to the DO; on `voice-session` it performs UDP IP discovery and answers
   the DO with its IP/port; binary RTP frames forwarded to the Discord UDP
   endpoint byte-identical.
7. **Command handlers (5 checks):** `/nowplaying` names the current track
   and the pending submission count; `/queue` shows counts + up-next with
   submissions first; `/request` rejects YouTube URLs and accepts
   SoundCloud/Spotify URLs (and honestly reports submissions as not wired
   up yet when the endpoint is unconfigured).

### What the harness does NOT prove

- **Anything against live Discord.** The mocks implement the documented
  protocol shapes, but Discord's real voice servers may behave differently
  (different Ready payloads, DAVE enforcement, rate limits, disconnect
  codes). The live test below is the only thing that closes this.
- **Real UDP sockets in this VM.** This sandbox blocks outbound UDP
  (`sendto` → `EPERM`, even loopback — verified with Node and Python).
  The harness therefore runs the voice leg over `spike/virtual-udp.js`,
  an in-process stand-in for the `dgram` API (bind/send/message/address/
  close) that routes datagrams between registered ports. It proves
  everything above the socket layer; the socket call itself (`dgram.send`)
  is standard Node and is the same code path the relay uses in production.
  The harness probes the real socket first and records the result, so
  this substitution is visible, not hidden.
- **Opus encoding.** The radio Worker must serve Opus (48 kHz stereo) or
  the relay must transcode (`--transcode`, ffmpeg). The harness uses
  pre-encoded Opus; no transcoding path was exercised end to end.
- **DAVE (Discord's E2EE voice).** The voice identify uses
  `max_dave_protocol_version: 0` (transport-encrypted path), which voice
  servers still accept per current reports. One source states that after
  2026-03-01 all calls require E2EE and clients without DAVE support will
  be excluded. Whether that applies to bots is **unverified** — the live
  test must confirm the bot is not rejected for `max_dave_protocol_version:
  0`, and if it is, DAVE/MLS support becomes a new build task.

## What is needed to prove it live

1. **Gary creates the Discord application** (Developer Portal) and
   provides, via Secure Vault: bot token, public key, application ID.
   Do not paste them in chat or in the repo.
2. **Gary confirms the server + voice channel** the bot lives in, and who
   may use `/request` vs `/skip` (roles). No server is named anywhere in
   the HUB repo today.
3. **Deploy the Worker** (`wrangler deploy` after `wrangler secret put`
   for the three secrets), set the Interactions Endpoint URL to the Worker
   URL in the Developer Portal, register commands
   (`node scripts/register-commands.js --guild <guildId>`).
4. **Decide the relay question:** accept the minimal relay (path C) or
   direct another investigation (path B, WebRTC). If path C: run
   `node spike/relay.js --do wss://<worker-host>/relay/<guildId>` on the
   radio host, set `RELAY_URL` on the Worker, and re-deploy.
5. **Live test (the actual proof):** join a voice channel, run `/join`,
   and confirm (a) the bot appears in the channel, (b) audio is audible,
   (c) `/nowplaying` matches what is heard, (d) `/leave` disconnects
   cleanly. Then `/request` with a SoundCloud link and confirm the track
   enters the submissions queue.
6. **Music-source confirmation:** the bot plays the radio stream's music /
   queue (assumed yes). Also the live-vs-loop shape from the radio work —
   it decides what "play" actually pulls (live HLS vs looped playlist).

## Files

- `src/voice.js` — voice session, RTP/SRTP (AES-256-GCM), Opus pacer
- `src/gateway.js` — gateway state machine (pure, no platform APIs)
- `src/gateway-do.js` — Durable Object wrapper (alarms, relay socket)
- `src/relay-protocol.js` — DO ↔ relay wire protocol
- `spike/relay.js` — reference relay implementation (Node)
- `spike/run-spike.js` — the harness (36 checks)
- `spike/mock-gateway.js`, `spike/mock-radio.js`, `spike/opus.js`,
  `spike/virtual-udp.js` — mocks + virtual UDP transport
