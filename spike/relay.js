// Voice relay — reference implementation (Node).
//
// The relay is the one piece of Lucifer that cannot run on Cloudflare: it
// owns a UDP socket to Discord's voice server. Everything else — commands,
// gateway signalling, queue state, speaking signals — stays on the Worker /
// Durable Object. The relay is deliberately tiny (~250 lines): it receives
// finished RTP packets from the DO over a WebSocket and forwards them over
// UDP, and it performs UDP IP discovery on the DO's behalf.
//
// Run:  node spike/relay.js --do wss://<worker-host>/relay/<guildId>
//       (defaults to ws://127.0.0.1:8787/relay/test-guild for local spike runs)
// The relay holds no credentials and no music: the secret key arrives per
// voice session from the DO, and audio arrives as Opus frames from the DO.
// Opus source: the DO pulls Opus audio from the radio Worker (see
// docs/shared-queue-contract.md); if the radio serves MP3/HLS instead, run
// the relay with --transcode and it will pipe the audio through ffmpeg
// (ffmpeg must be installed) into 48 kHz stereo Opus before forwarding.

import { WebSocket } from 'ws';
import dgram from 'node:dgram';
import { spawn } from 'node:child_process';
import {
  buildIpDiscoveryPacket,
  parseIpDiscoveryResponse,
} from '../src/voice.js';
import { DoToRelay, RelayToDo, relayMessage, validateRelayMessage } from '../src/relay-protocol.js';

const args = process.argv.slice(2);
function arg(name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

const DO_URL = arg('--do', 'ws://127.0.0.1:8787/relay/test-guild');
const TRANSCODER = args.includes('--transcode');

export class VoiceRelay {
  constructor({ doUrl, createSocket }) {
    this.doUrl = doUrl;
    this.ws = null;
    // createSocket is injectable so the spike harness can run the relay
    // over the virtual UDP transport (this sandbox blocks real UDP sends).
    this.udp = createSocket ? createSocket() : dgram.createSocket('udp4');
    this.voiceIp = null;
    this.voicePort = 0;
    this.ssrc = 0;
    this.audioUrl = null;
    this.ffmpeg = null;
    this.packetsForwarded = 0;
    this.bytesForwarded = 0;
    this.udp.on('message', (msg) => this.onUdpMessage(msg));
    this.udp.on('error', (err) => console.error('[relay] udp error', err));
  }

  async start() {
    await new Promise((resolve, reject) => {
      this.udp.bind(0, () => resolve());
      this.udp.once('error', reject);
    });
    this.ws = new WebSocket(this.doUrl);
    this.ws.on('open', () => {
      this.ws.send(relayMessage(RelayToDo.HELLO, {
        capabilities: ['udp', 'opus', ...(TRANSCODER ? ['transcode'] : [])],
      }));
      console.log(`[relay] connected to DO at ${this.doUrl}`);
    });
    this.ws.on('message', (raw, isBinary) => this.onDoMessage(raw, isBinary));
    this.ws.on('close', () => console.log('[relay] DO connection closed'));
    this.ws.on('error', (err) => console.error('[relay] ws error', err.message));
  }

  onUdpMessage(msg) {
    // IP discovery response (74 bytes, type 2) — answer the DO.
    if (msg.length >= 74 && msg.readUInt16BE(0) === 2) {
      try {
        const { ip, port } = parseIpDiscoveryResponse(new Uint8Array(msg));
        this.ws.send(relayMessage(RelayToDo.IP_DISCOVERY, { ip, port }));
      } catch (err) {
        console.error('[relay] bad IP discovery response', err.message);
      }
    }
    // Inbound voice packets from other users are ignored in v1 (Lucifer
    // only sends audio; it does not listen).
  }

  onDoMessage(raw, isBinary) {
    // Binary frames are finished RTP packets: forward them over UDP.
    // (The `ws` library delivers text frames as Buffers too, so the
    // isBinary flag — not Buffer.isBuffer — is what distinguishes them.)
    if (isBinary === true) {
      if (this.voiceIp && this.voicePort) {
        this.udp.send(raw, this.voicePort, this.voiceIp);
        this.packetsForwarded++;
        this.bytesForwarded += raw.length;
      }
      return;
    }
    // Text frames are DO -> relay JSON. (validateRelayMessage is the
    // opposite direction — DO-side validation of relay messages — so the
    // relay parses directly and switches on the DoToRelay type.)
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      console.error('[relay] invalid DO message: not JSON');
      return;
    }
    if (!msg || typeof msg.t !== 'string') {
      console.error('[relay] invalid DO message: missing type');
      return;
    }
    switch (msg.t) {
      case DoToRelay.VOICE_SESSION: {
        this.voiceIp = msg.endpoint.split(':')[0];
        this.voicePort = 0; // resolved by IP discovery below
        this.ssrc = msg.ssrc || 0;
        // UDP IP discovery: send the discovery packet to the voice server.
        const packet = buildIpDiscoveryPacket(this.ssrc);
        const host = msg.endpoint.split(':')[0];
        const port = Number(msg.endpoint.split(':')[1] || 443);
        this.voicePort = port;
        this.voiceIp = host;
        this.udp.send(Buffer.from(packet), port, host);
        console.log(`[relay] voice session: endpoint ${msg.endpoint}, ssrc ${this.ssrc}`);
        break;
      }
      case 'ip-discovery-request': {
        const packet = buildIpDiscoveryPacket(msg.ssrc);
        if (this.voiceIp && this.voicePort) {
          this.udp.send(Buffer.from(packet), this.voicePort, this.voiceIp);
        }
        break;
      }
      case DoToRelay.SECRET_KEY:
        // The DO encrypts RTP packets itself in v1, so the relay does not
        // need the key — it is logged (not stored) for the future shape
        // where the relay encrypts. Key material is never written to disk.
        console.log('[relay] secret key received (session-scoped, memory only)');
        break;
      case DoToRelay.PLAY:
        this.audioUrl = msg.audioUrl;
        if (TRANSCODER && this.audioUrl) this.startTranscode(this.audioUrl);
        console.log(`[relay] play: ${this.audioUrl}`);
        break;
      case DoToRelay.STOP:
        this.stopTranscode();
        console.log('[relay] stop');
        break;
      default:
        break;
    }
  }

  startTranscode(audioUrl) {
    this.stopTranscode();
    // ffmpeg: any input -> raw Opus packets are not emittable on stdout, so
    // transcode to Ogg Opus and let the DO parse pages. v1 note: the
    // preferred path is Opus served directly by the radio Worker; transcode
    // is the fallback for MP3/HLS sources.
    this.ffmpeg = spawn('ffmpeg', [
      '-re', '-i', audioUrl,
      '-vn', '-ac', '2', '-ar', '48000',
      '-c:a', 'libopus', '-b:a', '128k', '-f', 'ogg', '-',
    ], { stdio: ['ignore', 'pipe', 'ignore'] });
    this.ffmpeg.stdout.on('data', () => {});
    this.ffmpeg.on('error', (err) => console.error('[relay] ffmpeg error', err.message));
  }

  stopTranscode() {
    if (this.ffmpeg) {
      this.ffmpeg.kill('SIGTERM');
      this.ffmpeg = null;
    }
  }

  stats() {
    return { packetsForwarded: this.packetsForwarded, bytesForwarded: this.bytesForwarded };
  }

  async stop() {
    this.stopTranscode();
    if (this.ws) this.ws.close();
    await new Promise((resolve) => this.udp.close(() => resolve()));
  }
}

// Standalone run: `node spike/relay.js --do <ws-url>`
if (import.meta.url === `file://${process.argv[1]}`) {
  const relay = new VoiceRelay({ doUrl: DO_URL });
  relay.start().catch((err) => {
    console.error('[relay] failed to start', err);
    process.exit(1);
  });
  process.on('SIGINT', async () => {
    console.log('[relay] stats', relay.stats());
    await relay.stop();
    process.exit(0);
  });
}
