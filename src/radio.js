// Shared radio queue-state contract.
//
// Lucifer reads the SAME Worker song-load / queue state as the Pages portal.
// One queue, one source of truth, three surfaces (Pages portal, YouTube,
// Discord voice). The bot never keeps its own playlist.
//
// The radio Worker is being built in parallel (HUB repo radio work). Until it
// exists, this module defines the contract the radio Worker must serve, and
// every caller degrades gracefully when the endpoint is not configured yet.
// See docs/shared-queue-contract.md for the full contract.
//
// Contract shape (mirrors radio_service/queue_manager.py get_status()):
//   {
//     "nowPlaying": { "title", "artist", "source": "submission"|"playlist",
//                     "file", "played_at", "audioUrl" } | null,
//     "queueLength": number,        // submissions waiting (priority queue)
//     "playlistLength": number,     // tracks in the shuffled playlist
//     "submissionsPending": number, // == queueLength
//     "upNext": [ { "title", "artist", "source" } ],  // up to 5, optional
//     "stream": { "mode": "live"|"loop", "hlsUrl": string|null,
//                 "audioUrl": string|null }            // optional
//   }

export const SUBMISSION_DOMAINS = ['soundcloud.com', 'spotify.com', 'open.spotify.com'];
export const MAX_SUBMISSION_BYTES = 15 * 1024 * 1024; // 15 MB, mirrors POST /radio/submit

/** Is this a SoundCloud or Spotify URL? (Same rule as ARC POST /radio/submit.) */
export function isSubmittableUrl(rawUrl) {
  if (typeof rawUrl !== 'string') return false;
  let parsed;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
  const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
  return SUBMISSION_DOMAINS.some(
    (d) => host === d || host.endsWith(`.${d}`),
  );
}

/** Human-readable reason when a URL is not submittable. */
export function submittableUrlError(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string' || !rawUrl.trim()) {
    return 'Give me a link — paste a SoundCloud or Spotify track URL.';
  }
  return 'Only SoundCloud and Spotify URLs are accepted for the radio queue.';
}

/**
 * Fetch the shared queue status from the radio Worker.
 * Returns { connected: false } when RADIO_STATUS_URL is not configured,
 * { connected: true, status } on success, or { connected: true, error }
 * when the radio Worker answers with an error / is unreachable.
 */
export async function fetchRadioStatus(env) {
  const base = (env.RADIO_STATUS_URL || '').replace(/\/+$/, '');
  if (!base) return { connected: false };
  try {
    const res = await fetch(`${base}/radio/status`, {
      headers: { Accept: 'application/json' },
      // The radio Worker answers from KV/DO; keep this tight.
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      return { connected: true, error: `radio status ${res.status}` };
    }
    const status = await res.json();
    return { connected: true, status: normaliseStatus(status) };
  } catch (err) {
    return { connected: true, error: String(err && err.message ? err.message : err) };
  }
}

/** Coerce whatever the radio Worker returns into the documented shape. */
export function normaliseStatus(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  return {
    nowPlaying: s.nowPlaying ?? null,
    queueLength: Number(s.queueLength ?? 0) || 0,
    playlistLength: Number(s.playlistLength ?? 0) || 0,
    submissionsPending: Number(s.submissionsPending ?? s.queueLength ?? 0) || 0,
    upNext: Array.isArray(s.upNext) ? s.upNext.slice(0, 5) : [],
    stream: s.stream ?? null,
  };
}

/**
 * Submit a track URL into the shared submission flow.
 * Mirrors ARC POST /radio/submit: SoundCloud/Spotify only, yt-dlp download
 * (max 15 MB), quality gate, 3 accepted -> Verified badge.
 *
 * The Discord front end does NOT download or gate anything itself — it hands
 * the URL to the submission endpoint and reports the verdict back.
 * Returns { submitted: false, reason } when not wired up, or the endpoint's
 * verdict object ({ approved, verdict, score, issues, warnings, verification }).
 */
export async function submitTrack(env, { url, userId, guildId }) {
  const base = (env.RADIO_SUBMIT_URL || '').replace(/\/+$/, '');
  if (!base) {
    return {
      submitted: false,
      reason:
        'Submissions are not wired up yet — the radio submission endpoint is still being built. Your link was validated (SoundCloud/Spotify OK) but not queued.',
    };
  }
  try {
    const res = await fetch(`${base}/radio/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, source: 'discord', userId, guildId }),
      signal: AbortSignal.timeout(120000), // yt-dlp download can take a while
    });
    const json = await res.json().catch(() => null);
    if (!res.ok) {
      return {
        submitted: true,
        approved: false,
        verdict: 'Submission failed',
        score: 0,
        issues: [json && json.detail ? String(json.detail) : `submission endpoint ${res.status}`],
        warnings: [],
      };
    }
    return { submitted: true, ...(json || {}) };
  } catch (err) {
    return {
      submitted: true,
      approved: false,
      verdict: 'Submission failed',
      score: 0,
      issues: [String(err && err.message ? err.message : err)],
      warnings: [],
    };
  }
}

/** Format a track for chat: "Title — Artist (submission)". */
export function formatTrack(track) {
  if (!track) return 'nothing';
  const title = track.title || track.file || 'Unknown track';
  const artist = track.artist ? ` — ${track.artist}` : '';
  const source = track.source ? ` (${track.source})` : '';
  return `${title}${artist}${source}`;
}
