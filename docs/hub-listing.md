# HUB listing — Lucifer (prepared, NOT applied)

This doc is the exact change set for listing Lucifer on the HUB. It is
prepared here so the HUB owner can apply it; **do not edit the HUB repo
from this repo.** Apply when Lucifer is live in the Discord server, or
list as `coming_soon` first and flip to `active` on launch (see below).

All paths are relative to the HUB repo root
(`GareBear99/TizWildinEntertainmentHUB`).

## 1. promotionals.json entry

Add to the `promotionals` array (after `song_submission`, keeping the
coming-soon entries together):

```json
{
  "id": "discord_music_bot",
  "name": "Lucifer — TizWildin Discord Music Bot",
  "description": "Lucifer plays the TizWildin 24/7 radio stream in Discord voice channels — same songs, same queue as the radio portal and YouTube. /join, /play, /nowplaying, /queue, /request, /leave.",
  "category": "coming_soon",
  "url": "https://garebear99.github.io/TizWildinEntertainmentHUB/pages/discord-music-bot.html",
  "tags": ["discord", "music-bot", "lucifer", "radio", "voice"],
  "status": "planned"
}
```

On launch, flip to:

```json
  "category": "music",
  "url": "<bot invite URL — https://discord.com/oauth2/authorize?client_id=<APPLICATION_ID>&scope=bot%20applications.commands&permissions=3145728>",
  "status": "active"
```

Notes:

- The invite URL needs the real Application ID (Gary supplies it with the
  bot credentials) and the `bot` + `applications.commands` scopes.
  Permissions `3145728` = Connect (1048576) + Speak (2097152). Add Send
  Messages (2048) if the bot should reply in text channels outside
  interaction responses: `3147776`.
- `category` moves `coming_soon` → `music` on launch so the card leaves the
  Coming Soon group. Keep `status: planned` until the bot is actually in
  the server and `/join` has been heard live.
- Mirror the entry into `docs/promotionals.json` and `docs/data/` if the
  HUB's sync expects it (root ↔ docs ↔ docs/data are byte-identical for
  the other manifests — check after editing).

## 2. New per-route page: docs/pages/discord-music-bot.html

Follow the existing pattern exactly
(`docs/pages/tizwildin-24-7-radio-stream.html`,
`docs/pages/tizwildin-youtube.html`): same `<head>` (canonical, OG/Twitter,
JSON-LD `CreativeWork`, same inline CSS), hero with badge, description,
public-metadata table, SEO tags, related-routes block.

Concrete values for the generated page:

- Title: `Lucifer — TizWildin Discord Music Bot | TizWildin Ecosystem Index`
- Canonical: `https://garebear99.github.io/TizWildinEntertainmentHUB/pages/discord-music-bot.html`
- Badge (before launch): `Coming Soon Promotional Route`; after launch:
  `Promotional Route`
- Description: same as the promotionals.json description above.
- Metadata table rows:
  - Cluster: `Promotionals and Community`
  - Status: `planned` → `active` on launch
  - Repository: `https://github.com/GareBear99/LuciferMusicBot`
  - Docs: the page's own public URL
  - Language: `Web`
  - License: `Public route`
  - Source manifest: `promotionals.json`
- SEO tags: `discord`, `music-bot`, `lucifer`, `radio`, `voice`, `24-7`,
  `stream`
- Related ecosystem routes (link these pages):
  - `tizwildin-24-7-radio-stream.html` — TizWildin 24/7 Radio Stream
  - `tizwildin-youtube.html` — TizWildin YouTube
  - `song-submission-portal.html` — Song Submission Portal
  - `tizwildin-on-soundcloud.html` — TizWildin on SoundCloud
- Body addition (not in the generated radio page — add by hand after
  generation): a short "Commands" section listing `/join`, `/play`,
  `/nowplaying`, `/queue`, `/request <SoundCloud/Spotify URL>`, `/leave`,
  and a line that the bot plays the same queue as the radio (link the
  radio page). Keep it to one short section so the next index rebuild
  does not have to be hand-merged heavily.
- Social card: generate `docs/assets/social/discord-music-bot-card.svg`
  with the index build (same generator as the other route cards), and
  reference it in the OG/Twitter meta.

After adding the page, rebuild the public index (`scripts/build_public_index.py`)
so the sitemap, `public-index.json`, `llms.txt`, and search index pick it
up — the same rebuild the radio page went through.

## 3. Related-routes blocks on the sibling pages

Add a `discord-music-bot.html` link to the "Related ecosystem routes"
block of each of these (they are generated pages — add the link in the
generator's inputs if it rebuilds the block, otherwise hand-edit and note
it for the next rebuild):

- `docs/pages/tizwildin-24-7-radio-stream.html`
- `docs/pages/tizwildin-youtube.html`
- `docs/pages/song-submission-portal.html`

## 4. README roadmap line

In the HUB `README.md` roadmap section (near line 320, where the radio
checkbox sits), add:

```markdown
- [ ] Lucifer Discord music bot (Cloudflare Worker + radio stream) — repo: https://github.com/GareBear99/LuciferMusicBot
```

Check it (`- [x]`) on launch, with the bot invite URL next to it.

## 5. docs/OPERATOR_RUNBOOK.md section

The radio has no runbook section today — the bot + radio get one together.
Add a section (exact content to fill in once the radio Worker lands):

```markdown
## Lucifer Discord music bot + 24/7 radio

- Bot repo: https://github.com/GareBear99/LuciferMusicBot
- Worker: `lucifer-music-bot` — https://lucifer-music-bot.admension.workers.dev
- Deploy: `wrangler deploy` (from the LuciferMusicBot repo)
- Secrets (Worker secrets only, never in any repo):
  `DISCORD_TOKEN`, `DISCORD_PUBLIC_KEY`, `DISCORD_APPLICATION_ID`
  — set with `wrangler secret put <NAME>`.
- Interactions Endpoint URL (Discord Developer Portal): the Worker URL +
  `/interactions`.
- Commands: `node scripts/register-commands.js --guild <guildId>`
  (instant, one server) or `--global` (up to 1h to propagate).
- Queue lives in: the radio Worker (shared queue state — see
  LuciferMusicBot `docs/shared-queue-contract.md`). Lucifer and the portal
  both read it; there is no second queue.
- Voice relay: `node spike/relay.js --do wss://<worker-host>/relay/<guildId>`
  on the radio host (see LuciferMusicBot `SPIKE.md` — the relay exists
  because Workers have no UDP sockets). Restart: re-run the command;
  the DO reconnects the gateway automatically.
- Restart / redeploy the bot: `wrangler deploy` again; the gateway DO
  resumes its session. No data loss — queue state lives in the radio Worker.
- If voice goes silent but commands answer: check the relay process first,
  then the DO `/state` (via the Worker), then Discord's voice server status.
```

## 6. Link the Lucifer repo from the HUB

- Route page (above): Repository row → `https://github.com/GareBear99/LuciferMusicBot`.
- README roadmap line (above).
- `lists.json` / ARC source spine: only if the HUB's source-spine
  conventions call for it — the bot is a service, not a list entry, so do
  not force it into `lists.json`. The route page + README link is enough.

## Ordering

1. List as `coming_soon` / `planned` with the route page once the Worker
   is deployed and commands are registered (bot may not be audible yet).
2. Flip `promotionals.json` to `music` / `active` + invite URL, check the
   README box, and fill in the runbook section once `/join` has been heard
   live in the server.
