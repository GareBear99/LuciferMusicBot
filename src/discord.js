// Minimal Discord REST client (Bot token auth).
// Only the calls Lucifer v1 needs: followup messages, voice-state lookup,
// and (in scripts/register-commands.js) command registration.
// No discord.js dependency — the Worker runtime has no Node APIs for it,
// and the surface here is small enough to speak HTTPS directly.

export const DISCORD_API = 'https://discord.com/api/v10';

/** Build the headers for a Bot-token REST call. */
export function botHeaders(token) {
  return {
    Authorization: `Bot ${token}`,
    'Content-Type': 'application/json',
    'User-Agent': 'DiscordBot (LuciferMusicBot, 0.1.0)',
  };
}

/**
 * Call the Discord REST API.
 * @returns {Promise<{ok: boolean, status: number, json: any}>}
 */
export async function discordApi(token, method, path, body = undefined) {
  const res = await fetch(`${DISCORD_API}${path}`, {
    method,
    headers: botHeaders(token),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { ok: res.ok, status: res.status, json };
}

/** Send a followup message to an interaction (after a deferred response). */
export async function followup(token, applicationId, interactionToken, content, ephemeral = false) {
  const body = { content };
  if (ephemeral) body.flags = 64; // EPHEMERAL
  return discordApi(
    token,
    'POST',
    `/webhooks/${applicationId}/${interactionToken}`,
    body,
  );
}

/** Edit the original deferred interaction response. */
export async function editOriginal(token, applicationId, interactionToken, content) {
  return discordApi(
    token,
    'PATCH',
    `/webhooks/${applicationId}/${interactionToken}/messages/@original`,
    { content },
  );
}

/**
 * Find which voice channel a user is in, via the Gateway-cached voice states
 * held by the Durable Object (see src/gateway.js). Falls back to the REST
 * voice-state endpoint when the DO has no record.
 * Returns a channel id string, or null.
 */
export async function findUserVoiceChannel(env, guildId, userId) {
  // 1. Ask the gateway DO — it tracks VOICE_STATE_UPDATE events live.
  try {
    const id = env.GATEWAY.idFromName(`guild:${guildId}`);
    const stub = env.GATEWAY.get(id);
    const res = await stub.fetch(
      new Request(`https://do/voice-state/${userId}?guildId=${guildId}`),
    );
    if (res.ok) {
      const data = await res.json();
      if (data.channelId) return data.channelId;
    }
  } catch {
    // DO unavailable — fall through to REST.
  }
  // 2. REST fallback (requires the bot to be in the guild).
  if (env.DISCORD_TOKEN) {
    const { ok, json } = await discordApi(
      env.DISCORD_TOKEN,
      'GET',
      `/guilds/${guildId}/voice-states/${userId}`,
    );
    if (ok && json && json.channel_id) return json.channel_id;
  }
  return null;
}
