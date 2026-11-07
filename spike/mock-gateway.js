// Mock Discord gateways for the spike harness.
//
// Two mock servers, both speaking the real protocol shapes:
//  - MockGateway: wss gateway — sends Hello, expects Identify, answers
//    Heartbeat ACKs, and on Voice State Update (op 4) sends
//    VOICE_STATE_UPDATE + VOICE_SERVER_UPDATE pointing at the mock voice
//    gateway. Records every opcode it sees.
//  - MockVoiceGateway: voice gateway v8 — sends Hello, expects Identify
//    (checks max_dave_protocol_version is present), answers Ready with a
//    random SSRC and aead_aes256_gcm_rtpsize in modes, expects Select
//    Protocol, answers Session Description with a random 32-byte key,
//    expects Speaking (op 5) before any audio.
//  - MockVoiceUdp: a UDP socket standing in for Discord's voice server —
//    answers IP-discovery packets (type 1 -> type 2 with our IP/port) and
//    records every RTP packet it receives for the harness to verify.
//
// Nothing here touches discord.com. The harness proves the protocol code,
// not a live Discord session — see SPIKE.md.

import { WebSocketServer } from 'ws';
import dgram from 'node:dgram';
import { randomBytes } from 'node:crypto';

export const TEST_SSRC = 424242;
export const TEST_SECRET_KEY = randomBytes(32);

export class MockGateway {
  constructor({ port, voiceEndpoint }) {
    this.port = port;
    this.voiceEndpoint = voiceEndpoint; // e.g. "127.0.0.1:60001"
    this.opcodesSeen = [];
    this.voiceStateUpdates = [];
    this.wss = new WebSocketServer({ port });
    this.wss.on('connection', (ws) => this.onConnection(ws));
  }

  onConnection(ws) {
    this.ws = ws;
    ws.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 500 } })); // Hello (500 ms so the harness sees an ACK fast)
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      this.opcodesSeen.push(msg.op);
      if (msg.op === 1) {
        ws.send(JSON.stringify({ op: 11, d: null })); // Heartbeat ACK
      } else if (msg.op === 2) {
        // Identify -> READY
        ws.send(JSON.stringify({
          op: 0, s: 1, t: 'READY',
          d: { v: 10, user: { id: '999000111222333444' }, session_id: 'mock-session-id-1', guilds: [] },
        }));
      } else if (msg.op === 4) {
        // Voice State Update -> bot joins channel; answer both events.
        this.voiceStateUpdates.push(msg.d);
        ws.send(JSON.stringify({
          op: 0, s: 2, t: 'VOICE_STATE_UPDATE',
          d: { guild_id: msg.d.guild_id, channel_id: msg.d.channel_id, user_id: '999000111222333444', session_id: 'mock-session-id-1' },
        }));
        ws.send(JSON.stringify({
          op: 0, s: 3, t: 'VOICE_SERVER_UPDATE',
          d: { token: 'mock-voice-token', guild_id: msg.d.guild_id, endpoint: this.voiceEndpoint },
        }));
      } else if (msg.op === 6) {
        ws.send(JSON.stringify({ op: 0, s: 4, t: 'RESUMED', d: {} }));
      }
    });
  }

  close() {
    this.wss.close();
    if (this.ws) this.ws.close();
  }
}

export class MockVoiceGateway {
  constructor({ port }) {
    this.port = port;
    this.opcodesSeen = [];
    this.identifyPayload = null;
    this.selectProtocolPayload = null;
    this.speakingSeen = false;
    this.wss = new WebSocketServer({ port });
    this.wss.on('connection', (ws) => this.onConnection(ws));
  }

  onConnection(ws) {
    this.ws = ws;
    ws.send(JSON.stringify({ op: 8, d: { heartbeat_interval: 500 } })); // Hello (500 ms so the harness sees an ACK fast)
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      this.opcodesSeen.push(msg.op);
      if (msg.op === 0) {
        this.identifyPayload = msg.d;
        ws.send(JSON.stringify({
          op: 2,
          d: {
            ssrc: TEST_SSRC,
            ip: '127.0.0.1',
            port: 60002,
            modes: ['aead_aes256_gcm_rtpsize'],
            experiments: [],
          },
        }));
      } else if (msg.op === 1) {
        this.selectProtocolPayload = msg.d;
        ws.send(JSON.stringify({
          op: 4,
          d: { mode: 'aead_aes256_gcm_rtpsize', secret_key: [...TEST_SECRET_KEY] },
        }));
      } else if (msg.op === 3) {
        ws.send(JSON.stringify({ op: 6, d: null })); // Heartbeat ACK
      } else if (msg.op === 5) {
        this.speakingSeen = true;
      }
    });
  }

  close() {
    this.wss.close();
    if (this.ws) this.ws.close();
  }
}

export class MockVoiceUdp {
  constructor({ port, createSocket }) {
    this.port = port;
    this.socket = createSocket ? createSocket() : dgram.createSocket('udp4');
    this.packets = []; // raw RTP packets received
    this.ipDiscoveryRequests = 0;
    this.socket.on('message', (msg, rinfo) => this.onMessage(msg, rinfo));
  }

  async start() {
    await new Promise((resolve) => this.socket.bind(this.port, '127.0.0.1', resolve));
  }

  onMessage(msg, rinfo) {
    // IP discovery: type 1 (request) -> type 2 (response) with IP/port.
    if (msg.length === 74 && msg.readUInt16BE(0) === 1) {
      this.ipDiscoveryRequests++;
      const res = Buffer.alloc(74);
      res.writeUInt16BE(2, 0);
      res.writeUInt16BE(70, 2);
      msg.copy(res, 4, 4, 8); // echo SSRC
      res.write(rinfo.address, 8, 'ascii');
      res.writeUInt16BE(rinfo.port, 72);
      this.socket.send(res, rinfo.port, rinfo.address);
      return;
    }
    this.packets.push(Buffer.from(msg));
  }

  close() {
    this.socket.close();
  }
}
