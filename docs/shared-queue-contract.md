# Shared queue contract — radio Worker ↔ Lucifer ↔ Pages portal

One queue, one source of truth, three surfaces: the Pages portal, YouTube,
and Lucifer (Discord voice). Lucifer never keeps its own playlist and never
decides what plays next. The radio Worker owns the queue; Lucifer and the
portal both read it.

This contract is defined here because the radio Worker is being built in
parallel (HUB repo radio work). The radio Worker must serve these endpoints;
until it does, Lucifer degrades gracefully (see "Not ready yet" below) and
the spike harness serves the same contract from `spike/mock-radio.js`.

The shape mirrors `radio_service/queue_manager.py` `get_status()` in the
HUB repo: submissions take priority over the shuffled playlist.

## GET /radio/status

Response (JSON):

```json
{
  "nowPlaying": {
    "title": "Track Title",
    "artist": "Artist Name",
    "source": "submission",
    "file": "sub_user_20261107_120000_Track_Title.mp3",
    "played_at": "2026-11-07T12:00:00Z",
    "audioUrl": "https://<radio-worker>/radio/audio/<id>"
  },
  "queueLength": 2,
  "playlistLength": 13,
  "submissionsPending": 2,
  "upNext": [
    { "title": "Next Track", "artist": "Someone", "source": "submission" }
  ],
  "stream": {
    "mode": "live",
    "hlsUrl": "https://<stream>/live.m3u8",
    "audioUrl": "https://<radio-worker>/radio/audio"
  }
}
```

Field notes:

- `nowPlaying` — the current track, or `null` when nothing is playing.
  `source` is `"submission"` or `"playlist"`.
- `queueLength` / `submissionsPending` — submissions waiting (the priority
  queue). These two are the same number; both are kept because
  `get_status()` returns both.
- `playlistLength` — tracks in the shuffled playlist.
- `upNext` — up to 5 upcoming tracks, submissions first, then playlist.
  Optional: if the radio Worker does not publish it yet, Lucifer says so
  instead of inventing a list.
- `stream.mode` — `"live"` (true broadcast, one FFmpeg pass) or `"loop"`
  (looping playlist served on demand). Gary picks; see the radio design.
- `stream.audioUrl` / `nowPlaying.audioUrl` — where the audio itself comes
  from. **The audio must be Opus, 48 kHz, stereo** for the Discord voice
  leg (Discord voice only speaks Opus). If the radio serves MP3 or HLS,
  the relay transcodes with ffmpeg (`spike/relay.js --transcode`) — that
  is the fallback, not the preferred path.

## POST /radio/submit

The Discord front end for the existing submission flow. Mirrors ARC
`POST /radio/submit` exactly:

- Request body: `{ "url", "source": "discord", "userId", "guildId" }`
- URL rule: **SoundCloud or Spotify only** (same domain allow-list as ARC:
  `soundcloud.com`, `spotify.com`, `open.spotify.com`).
- The endpoint downloads with yt-dlp (max 15 MB), runs the quality gate
  (loudness / clipping / duration / bitrate — `quality_gate.py`, score
  0–100, pass ≥ 50 with zero issues), and records the submission.
- 3 accepted tracks → the account earns the Verified badge (same rule as
  the portal).
- Response (same as ARC):
  `{ "approved", "verdict", "score", "file?", "issues", "warnings",
     "verification": { "acceptedCount", "verified" }, "newlyVerified?" }`
- Lucifer does NOT download, gate, or judge anything itself — it validates
  the URL shape, hands the URL to this endpoint, and reports the verdict.

Note the known ARC-side gap (HUB dissection §11): `routes.py` imports
`radio_service_quality.quality_check`, a module that does not exist — the
real function is `quality_check_submission` in
`radio_service/quality_gate.py` — so ARC submissions silently fall back to
a thin ffprobe check today. That import must be fixed before Discord
requests get the full gate, or Discord requests will get the thin check
too. Lucifer's `/request` reports whatever verdict the endpoint returns;
it cannot tell which gate ran.

## GET /radio/audio (or per-track audioUrl)

The audio feed the voice relay pulls from. Opus 48 kHz stereo preferred.
For a live broadcast this is the live feed; for a loop it is the current
track's audio. The relay paces it at 20 ms frames into Discord.

## Not ready yet

- The radio Worker does not exist yet as a deployed service, so
  `RADIO_STATUS_URL` and `RADIO_SUBMIT_URL` are empty in `wrangler.toml`.
  Until they are set, `/nowplaying` and `/queue` answer "the radio is not
  connected yet" and `/request` validates the URL and says submissions are
  not wired up yet. That is deliberate: no fake now-playing, no fake queue.
- The radio Worker must serve Opus for the voice leg, or the relay
  transcodes. Decide when the radio's audio shape lands.
