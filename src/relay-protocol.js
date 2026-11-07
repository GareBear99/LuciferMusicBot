// Wire protocol between the Gateway Durable Object and the voice relay.
//
// Why this exists: the Workers runtime has no outbound UDP sockets, so the
// Durable Object cannot send voice audio to Discord itself. The DO keeps
// everything a Worker CAN do — the Discord gateway WebSocket, the voice
// gateway WebSocket, queue state, speaking signals — and hands the one thing
// it cannot do (raw UDP to Discord's voice server) to a minimal relay
// process over a WebSocket. See SPIKE.md for the evidence and the decision
// this protocol is waiting on.
//
// Direction: the relay connects outbound to the DO:
//   wss://<worker-host>/relay/<guildId>
// The DO accepts the WebSocket and holds it (hibernation-aware). Messages
// are JSON, one per frame. `t` is the message type.

export const RELAY_PROTOCOL_VERSION = 1;

/** Message types: relay -> DO. */
export const RelayToDo = {
  HELLO: 'hello', // relay announces itself + capabilities
  IP_DISCOVERY: 'ip-discovery', // { ip, port } after UDP hole-punch
  STATE: 'state', // { state, error? } — relay-side playback state
  BYE: 'bye', // relay is going away
};

/** Message types: DO -> relay. */
export const DoToRelay = {
  VOICE_SESSION: 'voice-session', // { endpoint, token, sessionId, ssrc, guildId, channelId }
  SECRET_KEY: 'secret-key', // { key: base64(32 bytes) } from Session Description
  PLAY: 'play', // { audioUrl } — Opus 48 kHz stereo, or an HLS URL if relay transcodes
  STOP: 'stop', // stop playback (relay sends silence frames first)
  SPEAKING: 'speaking', // { speaking: boolean } — informational, DO owns op 5
};

/**
 * Validate an inbound relay message. Returns { ok: true, msg } or
 * { ok: false, error }. The DO drops invalid messages instead of crashing.
 */
export function validateRelayMessage(raw) {
  let msg;
  try {
    msg = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return { ok: false, error: 'not JSON' };
  }
  if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') {
    return { ok: false, error: 'missing message type' };
  }
  if (msg.v !== undefined && msg.v !== RELAY_PROTOCOL_VERSION) {
    return { ok: false, error: `unsupported protocol version ${msg.v}` };
  }
  switch (msg.t) {
    case RelayToDo.HELLO:
      if (!Array.isArray(msg.capabilities)) return { ok: false, error: 'hello needs capabilities' };
      break;
    case RelayToDo.IP_DISCOVERY:
      if (typeof msg.ip !== 'string' || typeof msg.port !== 'number') {
        return { ok: false, error: 'ip-discovery needs ip + port' };
      }
      break;
    case RelayToDo.STATE:
      if (typeof msg.state !== 'string') return { ok: false, error: 'state needs state' };
      break;
    case RelayToDo.BYE:
      break;
    default:
      return { ok: false, error: `unknown relay message type ${msg.t}` };
  }
  return { ok: true, msg };
}

/** Build a DO -> relay message. */
export function doMessage(type, fields = {}) {
  return JSON.stringify({ v: RELAY_PROTOCOL_VERSION, t: type, ...fields });
}

/** Build a relay -> DO message. */
export function relayMessage(type, fields = {}) {
  return JSON.stringify({ v: RELAY_PROTOCOL_VERSION, t: type, ...fields });
}
