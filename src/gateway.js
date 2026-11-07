// Discord gateway — pure state machine, no platform APIs.
// Runs inside the Gateway Durable Object in production (see gateway-do.js),
// and against the mock gateway in the spike harness with the platform
// WebSocket global. The DO owns the socket lifetime (alarms keep the
// heartbeat alive across eviction); this class owns the protocol.
//
// Gateway opcodes used: 0 Dispatch, 1 Heartbeat, 2 Identify, 4 Voice State
// Update, 6 Resume, 7 Reconnect, 9 Invalid Session, 10 Hello, 11 Heartbeat ACK.
// Intents: GUILDS (1<<0) + GUILD_VOICE_STATES (1<<7) — the minimum Lucifer
// needs: guild create for the roster, voice states to find callers' channels
// and to receive VOICE_SERVER_UPDATE for /join.

export const GATEWAY_URL = 'wss://gateway.discord.gg/?v=10&encoding=json';

export const GatewayOpcode = {
  DISPATCH: 0,
  HEARTBEAT: 1,
  IDENTIFY: 2,
  PRESENCE_UPDATE: 3,
  VOICE_STATE_UPDATE: 4,
  RESUME: 6,
  RECONNECT: 7,
  REQUEST_GUILD_MEMBERS: 8,
  INVALID_SESSION: 9,
  HELLO: 10,
  HEARTBEAT_ACK: 11,
};

export const GatewayIntents = {
  GUILDS: 1 << 0,
  GUILD_VOICE_STATES: 1 << 7,
};

export const GatewayState = {
  IDLE: 'idle',
  CONNECTING: 'connecting',
  IDENTIFYING: 'identifying',
  READY: 'ready',
  RESUMING: 'resuming',
  DISCONNECTED: 'disconnected',
  FAILED: 'failed',
};

/**
 * @param {object} opts
 * @param {string} opts.token - bot token
 * @param {function} [opts.createWebSocket] - (url) => WebSocket; defaults to global WebSocket
 * @param {function} [opts.onState] - (state, detail) => void
 * @param {function} [opts.onVoiceServerUpdate] - ({ guildId, endpoint, token }) => void
 * @param {function} [opts.onReady] - ({ sessionId, userId }) => void
 */
export class GatewaySession {
  constructor(opts) {
    this.token = opts.token;
    this.gatewayUrl = opts.gatewayUrl || GATEWAY_URL;
    this.createWebSocket = opts.createWebSocket || ((url) => new WebSocket(url));
    this.onState = opts.onState || (() => {});
    this.onVoiceServerUpdate = opts.onVoiceServerUpdate || (() => {});
    this.onReady = opts.onReady || (() => {});
    this.state = GatewayState.IDLE;
    this.ws = null;
    this.sessionId = null;
    this.userId = null;
    this.sequence = null;
    this.heartbeatIntervalMs = 0;
    this.heartbeatTimer = null;
    this.lastHeartbeatAckAt = 0;
    /** Map userId -> channelId, from VOICE_STATE_UPDATE dispatches. */
    this.voiceStates = new Map();
    /** Map guildId -> { endpoint, token } from VOICE_SERVER_UPDATE. */
    this.voiceServers = new Map();
    /** Map guildId -> channelId the bot is currently in. */
    this.botVoiceChannels = new Map();
  }

  setState(state, detail) {
    this.state = state;
    this.onState(state, detail);
  }

  async connect() {
    this.setState(GatewayState.CONNECTING);
    this.ws = await this.createWebSocket(this.gatewayUrl);
    this.ws.addEventListener('message', (event) => {
      this.handleMessage(JSON.parse(event.data)).catch((err) => {
        this.setState(GatewayState.FAILED, { error: String(err) });
      });
    });
    this.ws.addEventListener('close', () => {
      this.stopHeartbeat();
      if (this.state !== GatewayState.DISCONNECTED) {
        this.setState(GatewayState.DISCONNECTED);
      }
    });
  }

  send(payload) {
    this.ws.send(JSON.stringify(payload));
  }

  heartbeat() {
    this.send({ op: GatewayOpcode.HEARTBEAT, d: this.sequence });
  }

  startHeartbeat() {
    this.stopHeartbeat();
    if (!this.heartbeatIntervalMs) return;
    // The DO also drives this from its alarm (alarms survive eviction, JS
    // timers do not). The in-process timer is the fast path; the alarm is
    // the durable one. Both call heartbeat().
    this.heartbeatTimer = setInterval(() => this.heartbeat(), this.heartbeatIntervalMs);
  }

  stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  identify() {
    this.setState(GatewayState.IDENTIFYING);
    this.send({
      op: GatewayOpcode.IDENTIFY,
      d: {
        token: this.token,
        intents: GatewayIntents.GUILDS | GatewayIntents.GUILD_VOICE_STATES,
        properties: { os: 'linux', browser: 'lucifer-music-bot', device: 'lucifer-music-bot' },
      },
    });
  }

  async handleMessage(msg) {
    if (typeof msg.s === 'number') this.sequence = msg.s;
    switch (msg.op) {
      case GatewayOpcode.HELLO: {
        this.heartbeatIntervalMs = msg.d.heartbeat_interval;
        this.startHeartbeat();
        if (this.sessionId) {
          this.setState(GatewayState.RESUMING);
          this.send({
            op: GatewayOpcode.RESUME,
            d: { token: this.token, session_id: this.sessionId, seq: this.sequence },
          });
        } else {
          this.identify();
        }
        break;
      }
      case GatewayOpcode.HEARTBEAT_ACK:
        this.lastHeartbeatAckAt = Date.now();
        break;
      case GatewayOpcode.RECONNECT:
        this.setState(GatewayState.DISCONNECTED, { reconnect: true });
        break;
      case GatewayOpcode.INVALID_SESSION:
        // Non-resumable when d === false: drop the session and re-identify.
        this.sessionId = null;
        this.setState(GatewayState.DISCONNECTED, { invalidSession: true });
        break;
      case GatewayOpcode.DISPATCH:
        this.handleDispatch(msg);
        break;
      default:
        break;
    }
  }

  handleDispatch(msg) {
    const { t, d } = msg;
    switch (t) {
      case 'READY':
        this.sessionId = d.session_id;
        this.userId = d.user && d.user.id;
        this.setState(GatewayState.READY, { sessionId: this.sessionId, userId: this.userId });
        this.onReady({ sessionId: this.sessionId, userId: this.userId });
        break;
      case 'RESUMED':
        this.setState(GatewayState.READY, { resumed: true });
        break;
      case 'VOICE_STATE_UPDATE': {
        // Track where every user (including the bot) is, per guild.
        if (d.user_id && d.guild_id) {
          if (d.channel_id) {
            this.voiceStates.set(`${d.guild_id}:${d.user_id}`, d.channel_id);
          } else {
            this.voiceStates.delete(`${d.guild_id}:${d.user_id}`);
          }
          if (d.user_id === this.userId) {
            if (d.channel_id) this.botVoiceChannels.set(d.guild_id, d.channel_id);
            else this.botVoiceChannels.delete(d.guild_id);
          }
        }
        break;
      }
      case 'VOICE_SERVER_UPDATE': {
        if (d.guild_id && d.endpoint) {
          this.voiceServers.set(d.guild_id, { endpoint: d.endpoint, token: d.token });
          this.onVoiceServerUpdate({
            guildId: d.guild_id,
            endpoint: d.endpoint,
            token: d.token,
          });
        }
        break;
      }
      default:
        break;
    }
  }

  /** Which voice channel is a user in (from cached VOICE_STATE_UPDATEs)? */
  voiceChannelFor(guildId, userId) {
    return this.voiceStates.get(`${guildId}:${userId}`) || null;
  }

  /** Ask Discord to move the bot into a voice channel (or out, channelId null). */
  updateVoiceState(guildId, channelId, { selfMute = false, selfDeaf = true } = {}) {
    this.send({
      op: GatewayOpcode.VOICE_STATE_UPDATE,
      d: { guild_id: guildId, channel_id: channelId, self_mute: selfMute, self_deaf: selfDeaf },
    });
  }

  disconnect() {
    this.stopHeartbeat();
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* already closed */
      }
    }
    this.setState(GatewayState.DISCONNECTED);
  }
}
