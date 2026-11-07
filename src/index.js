// Lucifer — Cloudflare Worker entrypoint (Interactions Endpoint).
//
// Discord POSTs slash-command interactions here. The Worker verifies the
// Ed25519 signature, answers PINGs, defers command handling, and routes
// everything else to the gateway Durable Object.
//
// Set this URL as the Interactions Endpoint URL in the Discord Developer
// Portal. Discord PING-verifies it before the portal will save it, so the
// Worker must be deployed (with DISCORD_PUBLIC_KEY set) first.
//
// Routes:
//   POST /interactions   Discord interactions (verified)
//   GET  /health         { status, version } — no auth, for uptime checks
//   GET  /               service card

import { verifyDiscordRequest } from './verify.js';
import { handleCommand, answerDeferred } from './commands.js';
import { GatewayDurableObject } from './gateway-do.js';

export { GatewayDurableObject };

const VERSION = '0.1.0';

const InteractionType = {
  PING: 1,
  APPLICATION_COMMAND: 2,
  MESSAGE_COMPONENT: 3,
  APPLICATION_COMMAND_AUTOCOMPLETE: 4,
  MODAL_SUBMIT: 5,
};

const InteractionResponseType = {
  PONG: 1,
  CHANNEL_MESSAGE_WITH_SOURCE: 4,
  DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE: 5,
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/health') {
      return json({ status: 'ok', version: VERSION, service: 'lucifer-music-bot' });
    }
    if (request.method === 'GET' && url.pathname === '/') {
      return json({
        service: 'Lucifer — TizWildin Discord music bot',
        version: VERSION,
        interactions: '/interactions',
        radio: env.RADIO_STATUS_URL ? 'configured' : 'not configured yet',
        relay: env.RELAY_URL ? 'configured' : 'not connected yet',
      });
    }

    if (request.method === 'POST' && url.pathname === '/interactions') {
      return this.handleInteraction(request, env, ctx);
    }

    return new Response('not found', { status: 404 });
  },

  async handleInteraction(request, env, ctx) {
    const signature = request.headers.get('X-Signature-Ed25519');
    const timestamp = request.headers.get('X-Signature-Timestamp');
    const rawBody = await request.text();

    if (!env.DISCORD_PUBLIC_KEY) {
      return json({ error: 'DISCORD_PUBLIC_KEY not set on the Worker' }, 500);
    }
    const valid = await verifyDiscordRequest(env.DISCORD_PUBLIC_KEY, signature, timestamp, rawBody);
    if (!valid) {
      return json({ error: 'invalid signature' }, 401);
    }

    const interaction = JSON.parse(rawBody);

    // Discord PING — answer immediately, no defer.
    if (interaction.type === InteractionType.PING) {
      return json({ type: InteractionResponseType.PONG });
    }

    if (interaction.type === InteractionType.APPLICATION_COMMAND) {
      // Defer first (Discord allows 3 s to ack), then do the work.
      ctx.waitUntil(
        (async () => {
          const text = await handleCommand(env, interaction);
          await answerDeferred(env, interaction, text);
        })(),
      );
      return json({ type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE });
    }

    // Components / autocomplete / modals: not used in v1.
    return json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: 'Lucifer v1 only answers slash commands.', flags: 64 },
    });
  },
};
