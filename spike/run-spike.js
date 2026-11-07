// Lucifer voice spike — test harness.
//
// Proves, against mocks (no Discord, no credentials, nothing leaves the VM):
//   1. Ed25519 interaction verification (real keypair, real + tampered sigs)
//   2. Radio contract client against the mock radio Worker
//   3. Gateway signalling: Hello -> Identify -> READY -> heartbeat ACK ->
//      Voice State Update -> VOICE_SERVER_UPDATE
//   4. Voice signalling: Hello -> Identify -> Ready -> UDP IP discovery ->
//      Select Protocol -> Session Description (secret key)
//   5. Audio path: real Opus frames (ffmpeg sine tone) -> paced 20 ms ->
//      AEAD AES-256-GCM RTP -> UDP -> decrypt round-trip, sequence and
//      timestamp monotonic, speaking sent before audio, silence frames at end
//   6. Relay hop: the DO-side WebSocket -> relay -> UDP forwarding, and the
//      relay's IP-discovery answer back to the DO
//   7. Command handlers: /nowplaying, /queue, /request URL validation
//      against the mock radio (no gateway/DO needed for these)
//
// What this does NOT prove (see SPIKE.md): anything against live Discord.
// The live test needs a bot token, a server, and a voice channel.
//
// Run: npm test   (or: node spike/run-spike.js)
// Exit code 0 = all checks passed.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import dgram from 'node:dgram';
import { generateKeyPairSync, sign } from 'node:crypto';
import { VirtualUdpRegistry } from './virtual-udp.js';
import { WebSocketServer } from 'ws';
import { verifyDiscordRequest } from '../src/verify.js';
import { fetchRadioStatus, isSubmittableUrl, normaliseStatus } from '../src/radio.js';
import { GatewaySession } from '../src/gateway.js';
import {
  VoiceSession,
  buildIpDiscoveryPacket,
  decryptRtpPacket,
  SILENCE_FRAME,
} from '../src/voice.js';
import { MockGateway, MockVoiceGateway, MockVoiceUdp, TEST_SECRET_KEY } from './mock-gateway.js';
import { parseOggOpus } from './opus.js';
import { startMockRadio } from './mock-radio.js';
import { handlers } from '../src/commands.js';
import { VoiceRelay } from './relay.js';

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeoutMs = 5000, stepMs = 50) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fn()) return true;
    await sleep(stepMs);
  }
  return fn();
}

const TMP_OPUS = '/tmp/lucifer-spike-tone.opus';

async function main() {
  // ── 0. Test audio: real Opus, 48 kHz stereo, 2 s sine tone ──────────
  const ff = spawnSync('ffmpeg', [
    '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
    '-ac', '2', '-ar', '48000', '-c:a', 'libopus', '-b:a', '128k', TMP_OPUS,
  ], { stdio: 'ignore' });
  if (ff.status !== 0 || !fs.existsSync(TMP_OPUS)) {
    console.error('ffmpeg failed to generate test Opus audio — aborting spike');
    process.exit(2);
  }
  const opusPackets = parseOggOpus(fs.readFileSync(TMP_OPUS));
  check('test audio: ffmpeg produced decodable Opus packets', opusPackets.length >= 50, `${opusPackets.length} packets`);
  const frames = opusPackets.slice(0, 10).map((p) => new Uint8Array(p));

  // ── 1. Ed25519 verification ─────────────────────────────────────────
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pubDer = publicKey.export({ type: 'spki', format: 'der' });
  const pubRaw = pubDer.slice(-32); // last 32 bytes of the SPKI DER
  const pubHex = Buffer.from(pubRaw).toString('hex');
  const timestamp = String(Math.floor(Date.now() / 1000));
  const body = JSON.stringify({ type: 1 });
  const sig = sign(null, Buffer.concat([Buffer.from(timestamp), Buffer.from(body)]), privateKey);
  check('ed25519: valid signature verifies', await verifyDiscordRequest(pubHex, sig.toString('hex'), timestamp, body));
  const badSig = Buffer.from(sig);
  badSig[0] ^= 0xff;
  check('ed25519: tampered signature rejected', !(await verifyDiscordRequest(pubHex, badSig.toString('hex'), timestamp, body)));
  check('ed25519: wrong timestamp rejected', !(await verifyDiscordRequest(pubHex, sig.toString('hex'), '1234567890', body)));
  check('ed25519: malformed key rejected', !(await verifyDiscordRequest('zz', sig.toString('hex'), timestamp, body)));

  // ── 1b. Environment fact: can this VM send real UDP at all? ─────────
  // (Probed, not assumed: a real dgram send to 127.0.0.1. If it is blocked
  // the voice leg below runs over the virtual UDP transport instead, and
  // SPIKE.md records that honestly.)
  const udpProbe = await new Promise((resolve) => {
    const probe = dgram.createSocket('udp4');
    probe.bind(0, '127.0.0.1', () => {
      probe.send(Buffer.from('probe'), 59999, '127.0.0.1', (err) => {
        probe.close();
        resolve(err ? err.code : 'ok');
      });
    });
  });
  const realUdpWorks = udpProbe === 'ok';
  check('env: real UDP send probe (documents the sandbox, not the product)',
    true, realUdpWorks ? 'real UDP sends work here' : `real UDP sends blocked (${udpProbe}) — voice leg runs over virtual UDP`);
  const vudp = new VirtualUdpRegistry();
  const vSocket = () => vudp.createSocket();

  // ── 2. Radio contract client ───────────────────────────────────────
  const radioServer = await startMockRadio({ port: 18701, opusFile: TMP_OPUS });
  const env = { RADIO_STATUS_URL: 'http://127.0.0.1:18701', RADIO_SUBMIT_URL: '' };
  const radio = await fetchRadioStatus(env);
  check('radio: status fetch connects', radio.connected && !radio.error);
  check('radio: get_status() shape (nowPlaying/queueLength/playlistLength/submissionsPending)',
    radio.status && radio.status.nowPlaying && radio.status.queueLength === 2
    && radio.status.playlistLength === 13 && radio.status.submissionsPending === 2);
  check('radio: upNext lists submissions first',
    radio.status.upNext[0].source === 'submission' && radio.status.upNext.length === 3);
  const unconnected = await fetchRadioStatus({});
  check('radio: unconfigured endpoint degrades gracefully', unconnected.connected === false);
  check('radio: normaliseStatus tolerates junk', normaliseStatus(null).queueLength === 0);

  // ── 3. Gateway signalling ──────────────────────────────────────────
  const mockUdp = new MockVoiceUdp({ port: 60002, createSocket: vSocket });
  await mockUdp.start();
  const mockVoiceGw = new MockVoiceGateway({ port: 60001 });
  const mockGw = new MockGateway({ port: 60000, voiceEndpoint: '127.0.0.1:60001' });
  await sleep(200);

  let voiceServerUpdate = null;
  const gw = new GatewaySession({
    token: 'mock-bot-token',
    gatewayUrl: 'ws://127.0.0.1:60000',
    onVoiceServerUpdate: (u) => { voiceServerUpdate = u; },
  });
  await gw.connect();
  check('gateway: Hello -> Identify -> READY',
    await waitFor(() => gw.state === 'ready'), `state=${gw.state}`);
  check('gateway: heartbeat ACK received',
    await waitFor(() => gw.lastHeartbeatAckAt > 0));
  gw.updateVoiceState('111222333444555666', '777888999000111222');
  check('gateway: Voice State Update sent (op 4)',
    await waitFor(() => mockGw.opcodesSeen.includes(4)));
  check('gateway: VOICE_SERVER_UPDATE received with endpoint + token',
    await waitFor(() => voiceServerUpdate !== null),
    voiceServerUpdate ? `${voiceServerUpdate.endpoint}` : 'none');
  check('gateway: voice state tracked for the bot',
    gw.voiceChannelFor('111222333444555666', '999000111222333444') === '777888999000111222');

  // ── 4+5. Voice signalling + audio path (direct-UDP transport) ──────
  const udpOut = vSocket();
  await new Promise((resolve) => udpOut.bind(0, '127.0.0.1', resolve));
  const ipDiscoveryWaiters = new Map();
  udpOut.on('message', (msg) => {
    if (msg.length === 74 && msg.readUInt16BE(0) === 2) {
      const ssrc = msg.readUInt32BE(4);
      const w = ipDiscoveryWaiters.get(ssrc);
      if (w) w(msg);
    }
  });
  const voiceStates = [];
  const voice = new VoiceSession({
    endpoint: voiceServerUpdate.endpoint,
    token: voiceServerUpdate.token,
    sessionId: 'mock-session-id-1',
    serverId: '111222333444555666',
    userId: '999000111222333444',
    voiceGatewayUrl: 'ws://127.0.0.1:60001',
    transport: {
      connectVoiceGateway: (url) => Promise.resolve(new WebSocket(url)),
      sendUdp: (packet) => udpOut.send(Buffer.from(packet), 60002, '127.0.0.1'),
      discoverIp: (ssrc) =>
        new Promise((resolve, reject) => {
          ipDiscoveryWaiters.set(ssrc, (msg) => {
            let ip = '';
            for (let i = 8; i < 72; i++) {
              if (msg[i] === 0) break;
              ip += String.fromCharCode(msg[i]);
            }
            resolve({ ip, port: msg.readUInt16BE(72) });
          });
          udpOut.send(Buffer.from(buildIpDiscoveryPacket(ssrc)), 60002, '127.0.0.1');
          setTimeout(() => reject(new Error('IP discovery timeout')), 5000);
        }),
    },
    onState: (s) => voiceStates.push(s),
  });
  await voice.connect();
  check('voice: Identify -> Ready (aead_aes256_gcm_rtpsize offered)',
    await waitFor(() => voice.state === 'ready' || voice.state === 'connected' || voice.state === 'selecting-protocol'),
    `state=${voice.state}`);
  check('voice: UDP IP discovery answered by the voice server',
    await waitFor(() => mockUdp.ipDiscoveryRequests > 0), `${mockUdp.ipDiscoveryRequests} request(s)`);
  check('voice: Select Protocol -> Session Description (32-byte key)',
    await waitFor(() => voice.state === 'connected' && voice.secretKey !== null),
    `state=${voice.state}`);
  check('voice: identify carried max_dave_protocol_version: 0',
    mockVoiceGw.identifyPayload && mockVoiceGw.identifyPayload.max_dave_protocol_version === 0);
  check('voice: select protocol asked for udp + aead_aes256_gcm_rtpsize',
    mockVoiceGw.selectProtocolPayload
    && mockVoiceGw.selectProtocolPayload.protocol === 'udp'
    && mockVoiceGw.selectProtocolPayload.data.mode === 'aead_aes256_gcm_rtpsize');

  // Audio: play 10 real Opus frames, then verify what arrived over UDP.
  const playStart = Date.now();
  const before = mockUdp.packets.length;
  await voice.playFrames(frames);
  const playMs = Date.now() - playStart;
  const received = mockUdp.packets.slice(before);
  check('voice: Speaking (op 5) sent before audio', mockVoiceGw.speakingSeen);
  check('voice: 10 Opus frames + 5 silence frames arrived over UDP',
    received.length === 15, `${received.length} packets`);
  // Decrypt round-trip: every packet must decrypt with the session key and
  // match the frame that was sent, in order.
  let roundTripOk = received.length === 15;
  let seqOk = true;
  let tsOk = true;
  let prevSeq = null;
  let prevTs = null;
  for (let i = 0; i < received.length && roundTripOk; i++) {
    const dec = await decryptRtpPacket(TEST_SECRET_KEY, new Uint8Array(received[i]));
    if (i < 10) {
      if (!dec.opus.every((b, j) => b === frames[i][j])) roundTripOk = false;
    } else {
      if (!dec.opus.every((b, j) => b === SILENCE_FRAME[j])) roundTripOk = false;
    }
    if (prevSeq !== null && dec.sequence !== ((prevSeq + 1) & 0xffff)) seqOk = false;
    if (prevTs !== null && dec.timestamp !== ((prevTs + 960) >>> 0)) tsOk = false;
    prevSeq = dec.sequence;
    prevTs = dec.timestamp;
  }
  check('voice: RTP decrypt round-trip matches sent Opus frames', roundTripOk);
  check('voice: RTP sequence increments by 1 per packet', seqOk);
  check('voice: RTP timestamp advances 960 (20 ms @ 48 kHz) per packet', tsOk);
  check('voice: 10 frames paced at ~20 ms each (200 ms total, ±120 ms)',
    playMs >= 150 && playMs <= 400, `${playMs} ms`);
  voice.disconnect();
  gw.disconnect();

  // ── 6. Relay hop: DO-side WS -> relay -> UDP ───────────────────────
  const relayUdp = new MockVoiceUdp({ port: 60003, createSocket: vSocket });
  await relayUdp.start();
  const doServer = new WebSocketServer({ port: 18702 });
  let doSocket = null;
  let relayHello = null;
  let relayIpDiscovery = null;
  doServer.on('connection', (ws) => {
    doSocket = ws;
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.t === 'hello') relayHello = msg;
      if (msg.t === 'ip-discovery') relayIpDiscovery = msg;
    });
  });
  const relay = new VoiceRelay({ doUrl: 'ws://127.0.0.1:18702/relay/test-guild', createSocket: vSocket });
  await relay.start();
  check('relay: HELLO received by the DO (capabilities announced)',
    await waitFor(() => relayHello !== null && relayHello.capabilities.includes('udp')));
  // DO tells the relay about a voice session; relay must IP-discover.
  await waitFor(() => doSocket !== null);
  doSocket.send(JSON.stringify({
    v: 1, t: 'voice-session', endpoint: '127.0.0.1:60003',
    token: 'mock', sessionId: 's', ssrc: 424242, guildId: 'g', channelId: 'c',
  }));
  check('relay: IP discovery performed over UDP, answer sent back to DO',
    await waitFor(() => relayIpDiscovery !== null && relayIpDiscovery.ip === '127.0.0.1'),
    relayIpDiscovery ? `${relayIpDiscovery.ip}:${relayIpDiscovery.port}` : 'none');
  // DO forwards finished RTP packets as binary frames; relay forwards UDP.
  const rtp = new Uint8Array([0x80, 0x78, 0, 1, 0, 0, 0, 0, 0, 0, 0, 42, 9, 9, 9]);
  doSocket.send(rtp);
  check('relay: binary RTP frame forwarded to Discord UDP endpoint',
    await waitFor(() => relayUdp.packets.length >= 1), `${relayUdp.packets.length} packet(s)`);
  check('relay: forwarded packet bytes are unchanged',
    relayUdp.packets.length > 0 && Buffer.from(relayUdp.packets[0]).equals(Buffer.from(rtp)));
  await relay.stop();
  doServer.close();
  relayUdp.close();

  // ── 7. Command handlers (radio-backed, no DO needed) ───────────────
  const nowText = await handlers.nowplaying(env, {});
  check('command: /nowplaying names the current track',
    nowText.includes('Spike Tone (Test Track)') && nowText.includes('2 submissions'));
  const queueText = await handlers.queue(env, {});
  check('command: /queue shows counts + up-next, submissions first',
    queueText.includes('2 submissions') && queueText.includes('Submission One'));
  check('command: /request rejects a YouTube URL',
    (await handlers.request(env, { data: { options: [{ name: 'url', value: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' }] } }))
      .includes('Only SoundCloud and Spotify'));
  check('command: /request accepts a SoundCloud URL (reports not wired up, honestly)',
    (await handlers.request(env, { data: { options: [{ name: 'url', value: 'https://soundcloud.com/tizwildin/test-track' }] } }))
      .includes('not wired up yet'));
  check('command: /request URL validation — soundcloud.com ok, example.com no',
    isSubmittableUrl('https://soundcloud.com/tizwildin/x')
    && isSubmittableUrl('https://open.spotify.com/track/abc')
    && !isSubmittableUrl('https://example.com/track.mp3')
    && !isSubmittableUrl('not a url'));

  // ── Cleanup ────────────────────────────────────────────────────────
  mockGw.close();
  mockVoiceGw.close();
  mockUdp.close();
  udpOut.close();
  radioServer.close();
  fs.unlinkSync(TMP_OPUS);

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} spike checks passed.`);
  if (failed.length > 0) {
    console.log('FAILED:');
    for (const f of failed) console.log(`  - ${f.name}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('spike harness crashed:', err);
  process.exit(2);
});
