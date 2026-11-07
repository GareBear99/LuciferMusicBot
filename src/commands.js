// Lucifer v1 slash commands.
//
// Six commands, small surface on purpose:
//   /join       join the caller's voice channel and play the radio stream
//   /play       play / resume the radio stream in the current channel
//   /nowplaying current track from the shared queue state
//   /queue      what's coming up (submissions first, then playlist)
//   /request    <url> — SoundCloud/Spotify URL into the submission flow
//   /leave      leave the voice channel
//
// Command handlers answer fast: they defer (type 5) and then edit the
// original response, because DO round-trips can exceed Discord's 3 s
// interaction window. Text shown to users is plain about what is and is
// not working yet — no fake "now playing" when the radio is not connected.

import { editOriginal } from './discord.js';
import { fetchRadioStatus, formatTrack, isSubmittableUrl, submitTrack, submittableUrlError } from './radio.js';

export const COMMANDS = [
  {
    name: 'join',
    description: 'Lucifer joins your voice channel and plays the TizWildin 24/7 radio stream',
  },
  {
    name: 'play',
    description: 'Play / resume the TizWildin 24/7 radio stream in the current voice channel',
  },
  {
    name: 'nowplaying',
    description: 'What is playing on the TizWildin radio right now',
  },
  {
    name: 'queue',
    description: 'What is coming up on the TizWildin radio (submissions first, then the playlist)',
  },
  {
    name: 'request',
    description: 'Request a track for the radio — SoundCloud or Spotify link, same as the submission portal',
    options: [
      {
        name: 'url',
        description: 'SoundCloud or Spotify track URL',
        type: 3, // STRING
        required: true,
      },
    ],
  },
  {
    name: 'leave',
    description: 'Lucifer leaves the voice channel',
  },
];

/** Look up an option value by name from the interaction data. */
function option(interaction, name) {
  const opts = (interaction.data && interaction.data.options) || [];
  const found = opts.find((o) => o.name === name);
  return found ? found.value : undefined;
}

function guildIdOf(interaction) {
  return interaction.guild_id || null;
}

function userIdOf(interaction) {
  return (interaction.member && interaction.member.user && interaction.member.user.id)
    || (interaction.user && interaction.user.id)
    || null;
}

function userNameOf(interaction) {
  const member = interaction.member || {};
  return member.nick
    || (member.user && member.user.global_name)
    || (member.user && member.user.username)
    || (interaction.user && interaction.user.username)
    || 'someone';
}

/** Ask the gateway DO to join / leave. Returns the DO's JSON answer. */
async function doCall(env, guildId, path, body) {
  const id = env.GATEWAY.idFromName(`guild:${guildId}`);
  const stub = env.GATEWAY.get(id);
  const res = await stub.fetch(
    new Request(`https://do/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    }),
  );
  return res.json().catch(() => ({ ok: false, error: `DO ${path} ${res.status}` }));
}

/** Shared join logic for /join and /play. */
async function doJoin(env, interaction) {
  const guildId = guildIdOf(interaction);
  const userId = userIdOf(interaction);
  if (!guildId) return 'Lucifer only works in a server — run this in a TizWildin server channel, not a DM.';
  if (!userId) return 'Could not tell who you are from this interaction. Try again.';

  const { findUserVoiceChannel } = await import('./discord.js');
  const channelId = await findUserVoiceChannel(env, guildId, userId);
  if (!channelId) {
    return 'Join a voice channel first, then run /join — I join the channel you are in.';
  }
  const result = await doCall(env, guildId, 'join', { guildId, channelId });
  if (!result.ok) {
    return `Could not join your channel: ${result.error || 'unknown error'}`;
  }
  if (result.state === 'joined-no-audio') {
    return 'Joined your voice channel. Voice playback is not live yet — the voice relay is still being built (see the repo SPIKE.md), so you will not hear audio. The radio itself is untouched; /nowplaying and /queue already work.';
  }
  const status = await fetchRadioStatus(env);
  const now = status.connected && status.status && status.status.nowPlaying
    ? `\nNow playing: ${formatTrack(status.status.nowPlaying)}`
    : '';
  return `Joined your voice channel — playing the TizWildin 24/7 radio stream.${now}`;
}

export const handlers = {
  async join(env, interaction) {
    return doJoin(env, interaction);
  },

  async play(env, interaction) {
    const guildId = guildIdOf(interaction);
    if (!guildId) return 'Lucifer only works in a server — run this in a TizWildin server channel, not a DM.';
    // If already in a channel, /play resumes the stream there; otherwise join.
    const { findUserVoiceChannel } = await import('./discord.js');
    const userId = userIdOf(interaction);
    const channelId = userId ? await findUserVoiceChannel(env, guildId, userId) : null;
    if (!channelId) {
      return 'Join a voice channel first, then run /play — or use /join.';
    }
    const result = await doCall(env, guildId, 'join', { guildId, channelId });
    if (!result.ok) return `Could not start playback: ${result.error || 'unknown error'}`;
    if (result.state === 'joined-no-audio') {
      return 'The radio stream is not audible in voice yet — the voice relay is still being built. /nowplaying and /queue already work.';
    }
    return 'Playing the TizWildin 24/7 radio stream.';
  },

  async nowplaying(env) {
    const result = await fetchRadioStatus(env);
    if (!result.connected) {
      return 'The radio is not connected yet — the radio Worker that owns the queue is still being built. Check back once the 24/7 stream is live.';
    }
    if (result.error) {
      return `Could not reach the radio right now (${result.error}). Try again in a bit.`;
    }
    const s = result.status;
    if (!s.nowPlaying) {
      return 'Nothing is playing right now — the radio queue is empty.';
    }
    const queueBit = s.queueLength > 0 ? `\n${s.queueLength} submission${s.queueLength === 1 ? '' : 's'} waiting in the queue.` : '';
    return `Now playing: ${formatTrack(s.nowPlaying)}${queueBit}`;
  },

  async queue(env) {
    const result = await fetchRadioStatus(env);
    if (!result.connected) {
      return 'The radio is not connected yet — the radio Worker that owns the queue is still being built. Check back once the 24/7 stream is live.';
    }
    if (result.error) {
      return `Could not reach the radio right now (${result.error}). Try again in a bit.`;
    }
    const s = result.status;
    const lines = [];
    lines.push(`Queue — ${s.submissionsPending} submission${s.submissionsPending === 1 ? '' : 's'} pending, ${s.playlistLength} track${s.playlistLength === 1 ? '' : 's'} in the playlist.`);
    if (s.nowPlaying) lines.push(`Now: ${formatTrack(s.nowPlaying)}`);
    if (s.upNext && s.upNext.length > 0) {
      s.upNext.forEach((t, i) => lines.push(`${i + 1}. ${formatTrack(t)}`));
    } else if (s.queueLength === 0 && s.playlistLength === 0) {
      lines.push('The queue is empty — use /request to put a track in.');
    } else {
      lines.push('(Up-next list not published by the radio yet — submissions play first, then the shuffled playlist.)');
    }
    return lines.join('\n');
  },

  async request(env, interaction) {
    const url = option(interaction, 'url');
    if (!isSubmittableUrl(url)) {
      return submittableUrlError(url);
    }
    const guildId = guildIdOf(interaction);
    const userId = userIdOf(interaction);
    const verdict = await submitTrack(env, { url, userId, guildId });
    if (!verdict.submitted) {
      return `${verdict.reason}\nYour link: ${url}`;
    }
    if (!verdict.approved) {
      const issues = (verdict.issues || []).join('; ');
      return `Not queued — the quality gate said no (score ${verdict.score ?? '?'}). ${issues}\nYour link: ${url}`;
    }
    let msg = `Queued for the radio — ${verdict.verdict || 'accepted'} (score ${verdict.score ?? '?'})`;
    if (verdict.warnings && verdict.warnings.length > 0) {
      msg += `\nNotes: ${verdict.warnings.join('; ')}`;
    }
    if (verdict.newlyVerified) {
      msg += '\nThat was your third accepted track — your HUB account is now VERIFIED.';
    } else if (verdict.verification && verdict.verification.acceptedCount !== undefined) {
      msg += `\nAccepted tracks on your account: ${verdict.verification.acceptedCount}/3 towards Verified.`;
    }
    return msg;
  },

  async leave(env, interaction) {
    const guildId = guildIdOf(interaction);
    if (!guildId) return 'Lucifer only works in a server — run this in a TizWildin server channel, not a DM.';
    const result = await doCall(env, guildId, 'leave', { guildId });
    if (!result.ok) return `Could not leave: ${result.error || 'unknown error'}`;
    return 'Left the voice channel. The radio keeps playing on the portal and YouTube.';
  },
};

/**
 * Dispatch an interaction to its handler and edit the deferred response.
 * The Worker entrypoint defers first (type 5), then calls this.
 */
export async function handleCommand(env, interaction) {
  const name = interaction.data && interaction.data.name;
  const handler = handlers[name];
  if (!handler) {
    return `Unknown command: ${name || '(none)'}`;
  }
  try {
    return await handler(env, interaction);
  } catch (err) {
    return `Something went wrong running /${name}: ${String(err && err.message ? err.message : err)}`;
  }
}

/** Edit the deferred original response with the handler's text. */
export async function answerDeferred(env, interaction, text) {
  const applicationId = env.DISCORD_APPLICATION_ID;
  const token = env.DISCORD_TOKEN;
  if (!applicationId || !token) return false;
  await editOriginal(token, applicationId, interaction.token, text);
  return true;
}

export { userNameOf };
