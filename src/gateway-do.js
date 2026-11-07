// Durable Object wrapper around the gateway state machine.
//
// One instance per guild: `env.GATEWAY.idFromName("guild:<guildId>")`.
// The DO is the only thing in the system that holds a live Discord gateway
// WebSocket, and it survives eviction via alarms (the heartbeat alarm wakes
// the DO on schedule even when the isolate was evicted).
//
// The DO also owns the voice session lifecycle for its guild: when the
// Worker asks it to join a channel it sends Gateway Op 4, waits for
// VOICE_SERVER_UPDATE, opens the voice gateway WebSocket, and drives the
// voice relay over the relay protocol (src/relay-protocol.js).
//
// Routes (internal, called by the Worker only — never exposed to Discord):
//   GET  /voice-state/:userId      -> { channelId: string | null }
//   POST /join                     { channelId } -> { ok, state | error }
//   POST /leave                    -> { ok, state }
//   GET  /state                    -> { gateway, voice, botChannelId }
//   WebSocket /relay/:guildId      -> relay connection (hibernation API)

import { GatewaySession, GatewayState } from './gateway.js';
import { VoiceSession } from './voice.js';
import {
  DoToRelay,
  RelayToDo,
  doMessage,
  validateRelayMessage,
} from './relay-protocol.js';

const HEARTBEAT_ALARM_MS = 40_000;

export class GatewayDurableObject {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.gateway = null;
    this.voice = null;
    this.relaySocket = null;
    this.pendingJoin = null; // { guildId, channelId, resolve, reject }
    this.storage = ctx.storage;
  }

  ensureGateway() {
    if (this.gateway) return this.gateway;
    this.gateway = new GatewaySession({
      token: this.env.DISCORD_TOKEN,
      onState: (state, detail) => {
        if (state === GatewayState.DISCONNECTED && detail && detail.reconnect) {
          // Reconnect with a fresh socket; resume uses the stored session id.
          this.gateway.connect().catch(() => {});
        }
      },
      onVoiceServerUpdate: ({ guildId, endpoint, token }) => {
        this.onVoiceServerUpdate(guildId, endpoint, token).catch(() => {});
      },
    });
    return this.gateway;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const parts = url.pathname.split('/').filter(Boolean);

    // Relay WebSocket: GET /relay/<guildId> with an Upgrade header.
    if (parts[0] === 'relay' && request.headers.get('Upgrade') === 'websocket') {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.ctx.acceptWebSocket(server);
      this.relaySocket = server;
      return new Response(null, { status: 101, webSocket: client });
    }

    if (parts[0] === 'voice-state' && parts[1]) {
      const gw = this.ensureGateway();
      return Response.json({
        channelId: gw.voiceChannelFor(this.guildIdFrom(request), parts[1]),
      });
    }

    if (parts[0] === 'state') {
      return Response.json(this.stateSnapshot());
    }

    if (parts[0] === 'join' && request.method === 'POST') {
      const { channelId, guildId } = await request.json().catch(() => ({}));
      return Response.json(await this.join(guildId, channelId));
    }

    if (parts[0] === 'leave' && request.method === 'POST') {
      const { guildId } = await request.json().catch(() => ({}));
      return Response.json(await this.leave(guildId));
    }

    return new Response('not found', { status: 404 });
  }

  guildIdFrom(request) {
    // The guild id is encoded in the DO name; the Worker passes it as a
    // query param on internal calls to keep this stateless.
    return new URL(request.url).searchParams.get('guildId') || '';
  }

  stateSnapshot() {
    return {
      gateway: this.gateway ? this.gateway.state : 'idle',
      voice: this.voice ? this.voice.state : 'idle',
      botChannelId: this.gateway
        ? [...this.gateway.botVoiceChannels.values()][0] || null
        : null,
      relayConnected: !!this.relaySocket,
    };
  }

  /** Connect the gateway if it is not already up. */
  async ensureConnected() {
    const gw = this.ensureGateway();
    if (gw.state === GatewayState.READY) return gw;
    if (gw.state === GatewayState.IDLE || gw.state === GatewayState.DISCONNECTED) {
      await gw.connect();
      // Keep the heartbeat alive across eviction: alarm every 40 s.
      await this.ctx.storage.setAlarm(Date.now() + HEARTBEAT_ALARM_MS);
    }
    return gw;
  }

  async alarm() {
    // Durable heartbeat: survives isolate eviction, unlike setInterval.
    const gw = this.gateway;
    if (gw && (gw.state === GatewayState.READY || gw.state === GatewayState.IDENTIFYING)) {
      gw.heartbeat();
      await this.ctx.storage.setAlarm(Date.now() + HEARTBEAT_ALARM_MS);
    }
  }

  async webSocketMessage(ws, raw) {
    const { ok, msg, error } = validateRelayMessage(raw);
    if (!ok) return; // drop invalid relay messages, do not crash
    if (msg.t === RelayToDo.IP_DISCOVERY && this.pendingIpDiscovery) {
      // The relay did UDP IP discovery for us; resolve the transport call
      // the VoiceSession is awaiting inside its READY handler.
      const pending = this.pendingIpDiscovery;
      this.pendingIpDiscovery = null;
      pending.resolve({ ip: msg.ip, port: msg.port });
    }
    if (msg.t === RelayToDo.STATE) {
      // Relay-side playback state; surfaced via /state for /nowplaying.
      this.relayState = msg.state;
    }
  }

  async webSocketClose() {
    this.relaySocket = null;
  }

  /**
   * Join a voice channel. Gateway Op 4 -> Discord answers with
   * VOICE_STATE_UPDATE + VOICE_SERVER_UPDATE, which onVoiceServerUpdate
   * turns into a voice session. Returns the join outcome; audio starts
   * when the relay reports it is connected and the voice session is up.
   */
  async join(guildId, channelId) {
    if (!guildId || !channelId) return { ok: false, error: 'guildId and channelId required' };
    if (!this.env.DISCORD_TOKEN) {
      return { ok: false, error: 'DISCORD_TOKEN not set on the Worker' };
    }
    const gw = await this.ensureConnected();
    if (!this.env.RELAY_URL && !this.relaySocket) {
      // Honest degradation: signalling works, but there is no UDP hop yet.
      // The bot can still join (gateway Op 4) so the caller's channel is
      // visible, but no audio can flow until the relay exists (SPIKE.md).
      gw.updateVoiceState(guildId, channelId);
      return {
        ok: true,
        state: 'joined-no-audio',
        note: 'Joined the channel, but the voice relay is not connected yet, so no audio can play. See SPIKE.md.',
      };
    }
    this.pendingJoin = { guildId, channelId };
    gw.updateVoiceState(guildId, channelId);
    return { ok: true, state: 'joining', note: 'Voice state update sent; waiting for voice server.' };
  }

  async onVoiceServerUpdate(guildId, endpoint, token) {
    const pending = this.pendingJoin;
    if (!pending || pending.guildId !== guildId) return;
    this.pendingJoin = null;
    const gw = this.gateway;
    // Hand the voice session to the relay: it owns the UDP socket.
    if (this.relaySocket) {
      this.relaySocket.send(
        doMessage(DoToRelay.VOICE_SESSION, {
          endpoint,
          token,
          sessionId: gw.sessionId,
          guildId,
          channelId: pending.channelId,
        }),
      );
    }
    this.voice = new VoiceSession({
      endpoint,
      token,
      sessionId: gw.sessionId,
      serverId: guildId,
      userId: gw.userId,
      transport: this.relayTransport(),
      onState: (state) => {
        if (state === 'connected' && this.relaySocket) {
          this.relaySocket.send(doMessage(DoToRelay.SECRET_KEY, {
            key: Buffer.from(this.voice.secretKey).toString('base64'),
          }));
        }
      },
    });
    await this.voice.connect();
  }

  /** Transport adapter: voice WS from the DO, UDP via the relay socket. */
  relayTransport() {
    return {
      connectVoiceGateway: (url) => Promise.resolve(new WebSocket(url)),
      sendUdp: (packet) => {
        // Opus frames go to the relay as binary WebSocket messages; the
        // relay encrypts (it holds the secret key) and sends UDP.
        // NOTE: in the v1 wiring the DO encrypts and the relay forwards the
        // finished RTP packet; see SPIKE.md for the two shapes.
        if (this.relaySocket) this.relaySocket.send(packet);
      },
      discoverIp: (ssrc) =>
        new Promise((resolve, reject) => {
          // The relay performs UDP IP discovery and answers over the socket.
          this.pendingIpDiscovery = { resolve, reject };
          if (this.relaySocket) {
            this.relaySocket.send(doMessage('ip-discovery-request', { ssrc }));
          } else {
            reject(new Error('relay not connected'));
          }
          setTimeout(() => reject(new Error('IP discovery timed out')), 10000);
        }),
    };
  }

  async leave(guildId) {
    if (this.voice) {
      this.voice.disconnect();
      this.voice = null;
    }
    const gw = this.gateway;
    if (gw && guildId) gw.updateVoiceState(guildId, null);
    if (this.relaySocket) this.relaySocket.send(doMessage(DoToRelay.STOP, {}));
    return { ok: true, state: 'left' };
  }
}
