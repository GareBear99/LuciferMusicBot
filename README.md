# Lucifer — TizWildin Discord Music Bot

Lucifer plays the TizWildin 24/7 radio stream in Discord voice channels —
the same songs, the same queue as the radio portal and YouTube. One queue,
one source of truth, three surfaces.

Lucifer is the first homunculus — Gary's AI — and the Discord music bot is
Lucifer.

## Commands (v1)

| Command | What it does |
|---|---|
| `/join` | Joins your voice channel and plays the radio stream |
| `/play` | Plays / resumes the radio stream in the current channel |
| `/nowplaying` | Current track, from the shared queue state |
| `/queue` | What's coming up — submissions first, then the playlist |
| `/request <url>` | SoundCloud/Spotify link into the radio submission flow (same URL rule, same quality gate, 3 accepted → Verified badge) |
| `/leave` | Leaves the voice channel |

## Architecture

Cloudflare, end to end — no server of Gary's own to babysit:

- **Interactions Endpoint — Cloudflare Worker** (`src/index.js`). Discord
  POSTs slash commands to the Worker URL; the Worker verifies the Ed25519
  signature (WebCrypto, no dependency) and answers with JSON. No persistent
  connection needed. PING handling + deferred command responses included.
- **Gateway — Durable Object** (`src/gateway.js`, `src/gateway-do.js`).
  One instance per guild. Holds the outbound WebSocket to
  `wss://gateway.discord.gg` with alarm-based keepalive (alarms survive
  eviction; JS timers do not), tracks voice states, and owns the voice
  session lifecycle.
- **Music source — Cloudflare, per the radio design.** The bot carries no
  music library and runs no encoder. It reads the same Worker song-load /
  queue state as the Pages portal — see
  `docs/shared-queue-contract.md`. `/request` posts into the same
  submission path as `POST /radio/submit`.
- **Voice transport — see `SPIKE.md`.** The spike's finding, stated
  plainly: the Workers runtime has no outbound UDP sockets, and Discord
  voice audio is UDP — so a pure-Worker voice leg is blocked by the
  platform, not by this code. The v1 design keeps everything a Worker can
  do on Cloudflare and hands the one thing it cannot do (raw UDP to
  Discord's voice server) to a minimal relay process (`spike/relay.js`,
  ~250 lines, no credentials, no music, no queue). Read `SPIKE.md` before
  deciding — it has the evidence, the alternatives assessed, and exactly
  what the live test needs.

## Repo layout

```
src/
  index.js           Worker entrypoint (Interactions Endpoint, /health)
  verify.js          Ed25519 verification (WebCrypto)
  discord.js         Discord REST helpers + voice-channel lookup
  commands.js        v1 slash command definitions + handlers
  radio.js           shared queue-state client + submission URL rules
  gateway.js         gateway state machine (pure, testable)
  gateway-do.js      Durable Object wrapper (alarms, relay socket)
  voice.js           voice session, RTP/SRTP, Opus pacer
  relay-protocol.js  DO <-> relay wire protocol
spike/
  run-spike.js       harness — 36 checks, `npm test`
  relay.js           reference voice relay (Node)
  mock-gateway.js    mock Discord gateway + voice gateway + voice UDP
  mock-radio.js      mock radio Worker (shared queue contract)
  opus.js            Ogg Opus packet parser (real ffmpeg audio)
  virtual-udp.js     in-process UDP stand-in (this sandbox blocks real UDP)
scripts/
  register-commands.js   register slash commands (code only — see below)
docs/
  shared-queue-contract.md   radio Worker contract (status + submit + audio)
  hub-listing.md             exact HUB changes to list Lucifer (not applied)
SPIKE.md               voice spike result — read this first
```

## Deploy

```bash
npm install
wrangler deploy
```

Secrets — Worker secrets only, never in the repo, never hardcoded, never
in a committed `.env`:

```bash
wrangler secret put DISCORD_TOKEN
wrangler secret put DISCORD_PUBLIC_KEY
wrangler secret put DISCORD_APPLICATION_ID
```

Then, in the Discord Developer Portal, set the **Interactions Endpoint
URL** to `https://lucifer-music-bot.admension.workers.dev/interactions`
(Discord PING-verifies it before saving). Register the commands:

```bash
DISCORD_TOKEN=... DISCORD_APPLICATION_ID=... node scripts/register-commands.js --guild <guildId>
```

`--guild` registers instantly in one server (use for testing); `--global`
registers everywhere and takes up to an hour to propagate. The script
refuses to run without credentials and dry-runs when none are set.

Configure the radio endpoints in `wrangler.toml` once the radio Worker
exists (`RADIO_STATUS_URL`, `RADIO_SUBMIT_URL`), and the relay URL
(`RELAY_URL`) once the relay is running. Until then the bot answers
honestly that the radio / voice relay is not connected yet — no fake
now-playing, no fake audio.

Local check (no credentials needed):

```bash
npm test          # spike harness, 36 checks, all mocked
npm run dev       # wrangler dev, http://localhost:8787/health
```

## Spike result (summary)

`npm test` passes 36/36 against mocks: Ed25519 verification, radio
contract client, gateway signalling (Identify → READY → Voice State Update
→ Voice Server Update), voice signalling (Identify → Ready → UDP IP
discovery → Select Protocol → Session Description), real Opus frames paced
at 20 ms through AES-256-GCM RTP with decrypt round-trip, sequence and
timestamp checks, and the relay hop (DO WebSocket → relay → UDP). What is
NOT proven: anything against live Discord — no token, application, server,
or voice channel exists yet. See `SPIKE.md` for the full result, the
platform gap, and the exact live test.

## Status

- v1 skeleton: built, tested against mocks, **not deployed, not live**.
- Blocked on Gary: bot token + public key + application ID (Secure Vault),
  Discord server + voice channel, music-source confirmation, live-vs-loop
  shape from the radio work, and the relay decision (`SPIKE.md`).
- HUB listing: prepared in `docs/hub-listing.md`, **not applied** — the
  HUB repo is owned by another agent.
