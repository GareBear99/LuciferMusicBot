// Discord voice — signalling state machine, RTP packet construction and
// Opus pacing. Transport-agnostic by design: this module never opens a
// socket. It talks to a `transport` object supplied by the caller:
//
//   transport = {
//     connectVoiceGateway(url): Promise<WebSocket>,  // voice WS (wss://...)
//     sendUdp(packet: Uint8Array): void,             // raw UDP to Discord
//     discoverIp(ssrc): Promise<{ip, port}>,         // UDP IP discovery
//     onUdpPacket: (packet) => void,                 // inbound UDP (optional)
//   }
//
// In production (Cloudflare) the transport is the voice relay (see
// src/relay-protocol.js + spike/relay.js): the Durable Object holds the voice
// WebSocket and forwards UDP work to the relay over a WebSocket, because the
// Workers runtime has no outbound UDP sockets (see SPIKE.md — this is the
// spike's central finding, reported with evidence, not worked around silently).
// In the spike harness the transport is a real Node dgram socket, so the
// protocol itself — identify, select protocol, speaking, RTP/SRTP, pacing —
// is proven against a mock Discord voice gateway end to end.
//
// Discord voice facts used here (Voice Connections, gateway v8/v9):
// - Voice data is Opus, 2 channels, 48 kHz, 20 ms frames (960 samples).
// - RTP header: 12 bytes, version 2, payload type 120 (dynamic, Opus).
// - Timestamp clock is 48 kHz: +960 per 20 ms frame. Sequence +1 per packet.
// - Opcode 5 Speaking must be sent before any audio, or Discord disconnects
//   with an invalid SSRC error.
// - Send 5 silence frames (0xF8, 0xFF, 0xFE) before stopping, to avoid Opus
//   interpolation artefacts.
// - Encryption mode: `aead_aes256_gcm_rtpsize` — the xsalsa20 modes were
//   discontinued 2024-11-18. AES-256-GCM via WebCrypto, nonce = the 12-byte
//   RTP header, AAD = the RTP header, 16-byte auth tag appended.
// - Voice Identify carries max_dave_protocol_version: 0, which takes the
//   transport-encrypted path (no DAVE/MLS). DAVE is Discord's E2EE voice
//   migration; whether bots are required to speak DAVE after 2026-03-01 is
//   an open question for the live test (see SPIKE.md).

export const OPUS_SAMPLE_RATE = 48000;
export const OPUS_FRAME_MS = 20;
export const OPUS_FRAME_SAMPLES = 960; // 48 kHz * 20 ms
export const OPUS_PAYLOAD_TYPE = 120;
export const RTP_HEADER_BYTES = 12;
export const SILENCE_FRAME = new Uint8Array([0xf8, 0xff, 0xfe]);
export const VOICE_GATEWAY_VERSION = 8;

export const VoiceOpcode = {
  IDENTIFY: 0,
  SELECT_PROTOCOL: 1,
  READY: 2,
  HEARTBEAT: 3,
  SESSION_DESCRIPTION: 4,
  SPEAKING: 5,
  HEARTBEAT_ACK: 6,
  RESUME: 7,
  HELLO: 8,
  RESUMED: 9,
  CLIENT_CONNECT: 12,
  CLIENT_DISCONNECT: 13,
};

export const VoiceState = {
  IDLE: 'idle',
  CONNECTING: 'connecting', // voice WS open, identify sent
  READY: 'ready', // Ready received, awaiting IP discovery
  SELECTING_PROTOCOL: 'selecting-protocol',
  CONNECTED: 'connected', // session description received, can send audio
  SPEAKING: 'speaking',
  DISCONNECTED: 'disconnected',
  FAILED: 'failed',
};

/** Build a 12-byte RTP header. */
export function buildRtpHeader({ sequence, timestamp, ssrc, payloadType = OPUS_PAYLOAD_TYPE }) {
  const header = new Uint8Array(RTP_HEADER_BYTES);
  const view = new DataView(header.buffer);
  header[0] = 0x80; // version 2, no padding, no extension, no CSRCs
  header[1] = payloadType & 0x7f; // marker bit 0
  view.setUint16(2, sequence & 0xffff, false);
  view.setUint32(4, timestamp >>> 0, false);
  view.setUint32(8, ssrc >>> 0, false);
  return header;
}

/**
 * Encrypt one Opus frame as an RTP packet (aead_aes256_gcm_rtpsize).
 * @param {Uint8Array} secretKey - 32-byte key from Opcode 4 Session Description
 * @param {number} sequence
 * @param {number} timestamp - 48 kHz clock
 * @param {number} ssrc
 * @param {Uint8Array} opusFrame - one 20 ms Opus frame
 * @returns {Promise<Uint8Array>} RTP header + ciphertext + 16-byte GCM tag
 */
export async function encryptRtpPacket(secretKey, sequence, timestamp, ssrc, opusFrame) {
  const header = buildRtpHeader({ sequence, timestamp, ssrc });
  const key = await crypto.subtle.importKey('raw', secretKey, { name: 'AES-GCM' }, false, [
    'encrypt',
  ]);
  // Nonce for the rtpsize mode is the 12-byte RTP header itself.
  const sealed = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: header, additionalData: header, tagLength: 128 },
    key,
    opusFrame,
  );
  const out = new Uint8Array(RTP_HEADER_BYTES + sealed.byteLength);
  out.set(header, 0);
  out.set(new Uint8Array(sealed), RTP_HEADER_BYTES);
  return out;
}

/**
 * Decrypt an RTP packet produced by encryptRtpPacket (spike round-trip).
 * @returns {Promise<{sequence: number, timestamp: number, ssrc: number, opus: Uint8Array}>}
 */
export async function decryptRtpPacket(secretKey, packet) {
  const header = packet.slice(0, RTP_HEADER_BYTES);
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  const key = await crypto.subtle.importKey('raw', secretKey, { name: 'AES-GCM' }, false, [
    'decrypt',
  ]);
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: header, additionalData: header, tagLength: 128 },
    key,
    packet.slice(RTP_HEADER_BYTES),
  );
  return {
    sequence: view.getUint16(2, false),
    timestamp: view.getUint32(4, false),
    ssrc: view.getUint32(8, false),
    opus: new Uint8Array(plain),
  };
}

/**
 * Build a UDP IP-discovery packet (74 bytes).
 * Discord replies with our externally-visible IP/port, which Select Protocol
 * needs. Sent over the UDP socket, never over the WebSocket.
 */
export function buildIpDiscoveryPacket(ssrc) {
  const packet = new Uint8Array(74);
  const view = new DataView(packet.buffer);
  view.setUint16(0, 1, false); // type 1 = request
  view.setUint16(2, 70, false); // length 70
  view.setUint32(4, ssrc >>> 0, false);
  return packet;
}

/** Parse Discord's IP-discovery response: IP string at offset 8, port at 72. */
export function parseIpDiscoveryResponse(packet) {
  if (packet.length < 74) throw new Error('IP discovery response too short');
  const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
  let ip = '';
  for (let i = 8; i < 72; i++) {
    const c = packet[i];
    if (c === 0) break;
    ip += String.fromCharCode(c);
  }
  return { ip, port: view.getUint16(72, false) };
}

/**
 * Paces Opus frames onto the 20 ms clock Discord requires.
 * Frames are handed to `onFrame(opusFrame)` one per tick; the pacer owns the
 * sequence/timestamp counters and the speaking state.
 */
export class OpusPacer {
  constructor({ ssrc, onFrame, onDone }) {
    this.ssrc = ssrc >>> 0;
    this.onFrame = onFrame;
    this.onDone = onDone || (() => {});
    this.sequence = 0;
    this.timestamp = 0;
    this.timer = null;
    this.queue = [];
    this.startedAt = 0;
    this.framesSent = 0;
  }

  /** Queue Opus frames (each exactly one 20 ms frame) for paced sending. */
  enqueue(frames) {
    for (const f of frames) this.queue.push(f);
  }

  start() {
    if (this.timer) return;
    this.startedAt = Date.now();
    this.timer = setInterval(() => this.tick(), OPUS_FRAME_MS);
  }

  tick() {
    const frame = this.queue.shift();
    if (frame === undefined) {
      this.stop();
      this.onDone();
      return;
    }
    const packet = {
      sequence: this.sequence,
      timestamp: this.timestamp,
      ssrc: this.ssrc,
      opus: frame,
    };
    this.sequence = (this.sequence + 1) & 0xffff;
    this.timestamp = (this.timestamp + OPUS_FRAME_SAMPLES) >>> 0;
    this.framesSent++;
    this.onFrame(packet);
  }

  /** Stop pacing and send the 5 silence frames Discord wants at the end. */
  async stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  silenceFrames() {
    const out = [];
    for (let i = 0; i < 5; i++) {
      out.push({
        sequence: this.sequence,
        timestamp: this.timestamp,
        ssrc: this.ssrc,
        opus: SILENCE_FRAME,
      });
      this.sequence = (this.sequence + 1) & 0xffff;
      this.timestamp = (this.timestamp + OPUS_FRAME_SAMPLES) >>> 0;
    }
    return out;
  }
}

/**
 * Voice session: the voice-gateway WebSocket signalling half.
 * The UDP half lives in the transport (relay in production, dgram in the spike).
 *
 * Flow: identify -> Ready (ssrc, ip, port, modes) -> IP discovery (transport)
 * -> Select Protocol (udp + aead_aes256_gcm_rtpsize + our ip/port)
 * -> Session Description (secret key) -> Speaking -> audio packets.
 */
export class VoiceSession {
  /**
   * @param {object} opts
   * @param {string} opts.endpoint - voice server endpoint, e.g. "us-west123.discord.media:443"
   * @param {string} opts.token - voice token from VOICE_SERVER_UPDATE
   * @param {string} opts.sessionId - gateway session id
   * @param {string} opts.serverId - guild id
   * @param {string} opts.userId - bot user id
   * @param {object} opts.transport - see module header
   * @param {function} [opts.onState] - (state, detail) => void
   */
  constructor(opts) {
    this.endpoint = opts.endpoint;
    this.token = opts.token;
    this.sessionId = opts.sessionId;
    this.serverId = opts.serverId;
    this.userId = opts.userId;
    this.transport = opts.transport;
    this.onState = opts.onState || (() => {});
    this.voiceGatewayUrlOverride = opts.voiceGatewayUrl || null;
    this.state = VoiceState.IDLE;
    this.ws = null;
    this.ssrc = 0;
    this.secretKey = null;
    this.heartbeatIntervalMs = 0;
    this.heartbeatTimer = null;
    this.pacer = null;
  }

  setState(state, detail) {
    this.state = state;
    this.onState(state, detail);
  }

  voiceGatewayUrl() {
    if (this.voiceGatewayUrlOverride) return this.voiceGatewayUrlOverride;
    const host = this.endpoint.replace(/:\d+$/, '');
    return `wss://${host}/?v=${VOICE_GATEWAY_VERSION}`;
  }

  async connect() {
    this.setState(VoiceState.CONNECTING);
    this.ws = await this.transport.connectVoiceGateway(this.voiceGatewayUrl());
    this.ws.addEventListener('message', (event) => {
      this.handleMessage(JSON.parse(event.data)).catch((err) => {
        this.setState(VoiceState.FAILED, { error: String(err) });
      });
    });
    this.ws.addEventListener('close', () => {
      if (this.state !== VoiceState.DISCONNECTED) {
        this.setState(VoiceState.DISCONNECTED);
      }
    });
  }

  send(payload) {
    this.ws.send(JSON.stringify(payload));
  }

  async handleMessage(msg) {
    switch (msg.op) {
      case VoiceOpcode.HELLO: {
        this.heartbeatIntervalMs = msg.d.heartbeat_interval;
        this.startHeartbeat();
        this.send({
          op: VoiceOpcode.IDENTIFY,
          d: {
            server_id: this.serverId,
            user_id: this.userId,
            session_id: this.sessionId,
            token: this.token,
            // Transport-encrypted path; no DAVE/MLS. See module header.
            max_dave_protocol_version: 0,
          },
        });
        break;
      }
      case VoiceOpcode.READY: {
        this.ssrc = msg.d.ssrc;
        const modes = msg.d.modes || [];
        if (!modes.includes('aead_aes256_gcm_rtpsize')) {
          throw new Error(
            `voice server does not offer aead_aes256_gcm_rtpsize (offered: ${modes.join(', ')})`,
          );
        }
        this.setState(VoiceState.READY, { ssrc: this.ssrc, modes });
        // IP discovery must go over UDP — the transport owns that socket.
        const { ip, port } = await this.transport.discoverIp(this.ssrc);
        this.setState(VoiceState.SELECTING_PROTOCOL, { ip, port });
        this.send({
          op: VoiceOpcode.SELECT_PROTOCOL,
          d: {
            protocol: 'udp',
            data: { address: ip, port, mode: 'aead_aes256_gcm_rtpsize' },
          },
        });
        break;
      }
      case VoiceOpcode.SESSION_DESCRIPTION: {
        const key = msg.d.secret_key;
        if (!key || key.length !== 32) {
          throw new Error('session description missing a 32-byte secret key');
        }
        this.secretKey = new Uint8Array(key);
        this.setState(VoiceState.CONNECTED, { ssrc: this.ssrc });
        break;
      }
      case VoiceOpcode.HEARTBEAT_ACK:
        break;
      case VoiceOpcode.RESUMED:
        this.setState(VoiceState.CONNECTED, { resumed: true });
        break;
      default:
        break;
    }
  }

  startHeartbeat() {
    this.stopHeartbeat();
    if (!this.heartbeatIntervalMs) return;
    this.heartbeatTimer = setInterval(() => {
      if (this.ws) {
        this.send({ op: VoiceOpcode.HEARTBEAT, d: Date.now() });
      }
    }, this.heartbeatIntervalMs);
  }

  stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /** Tell Discord we are about to speak. Required before any audio. */
  startSpeaking() {
    if (this.state !== VoiceState.CONNECTED && this.state !== VoiceState.SPEAKING) {
      throw new Error(`cannot speak while voice state is ${this.state}`);
    }
    this.send({
      op: VoiceOpcode.SPEAKING,
      d: { speaking: 1, delay: 0, ssrc: this.ssrc },
    });
    this.setState(VoiceState.SPEAKING, { ssrc: this.ssrc });
  }

  stopSpeaking() {
    if (this.ws) {
      this.send({
        op: VoiceOpcode.SPEAKING,
        d: { speaking: 0, delay: 0, ssrc: this.ssrc },
      });
    }
    this.setState(VoiceState.CONNECTED);
  }

  /**
   * Play Opus frames (each one 20 ms) over the transport.
   * @param {Uint8Array[]} frames
   * @returns {Promise<void>} resolves when the last frame + silence frames are sent
   */
  playFrames(frames) {
    if (!this.secretKey) throw new Error('no secret key — voice session not connected');
    if (this.state !== VoiceState.CONNECTED && this.state !== VoiceState.SPEAKING) {
      throw new Error(`cannot play while voice state is ${this.state}`);
    }
    this.startSpeaking();
    return new Promise((resolve) => {
      const sendPacket = async (packet) => {
        const encrypted = await encryptRtpPacket(
          this.secretKey,
          packet.sequence,
          packet.timestamp,
          packet.ssrc,
          packet.opus,
        );
        this.transport.sendUdp(encrypted);
      };
      this.pacer = new OpusPacer({
        ssrc: this.ssrc,
        onFrame: (packet) => {
          sendPacket(packet).catch((err) => this.setState(VoiceState.FAILED, { error: String(err) }));
        },
        onDone: async () => {
          // 5 silence frames, then stop speaking.
          for (const packet of this.pacer.silenceFrames()) {
            await sendPacket(packet);
          }
          this.stopSpeaking();
          resolve();
        },
      });
      this.pacer.enqueue(frames);
      this.pacer.start();
    });
  }

  disconnect() {
    this.stopHeartbeat();
    if (this.pacer) this.pacer.stop();
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* already closed */
      }
    }
    this.setState(VoiceState.DISCONNECTED);
  }
}
