// Ogg Opus parsing for the spike harness.
// The harness generates a real Opus file with ffmpeg (sine tone, 48 kHz
// stereo), then extracts the raw Opus packets from the Ogg container so the
// voice code can pace and encrypt them exactly as it would packets from the
// radio Worker. No Opus decoder is needed: the test verifies the bytes
// round-trip through encrypt -> UDP -> decrypt unchanged.

/** Split an Ogg Opus file buffer into its raw Opus packets. */
export function parseOggOpus(buffer) {
  const packets = [];
  let offset = 0;
  let packetBuffer = Buffer.alloc(0);
  let packetPending = false;

  while (offset < buffer.length) {
    if (buffer.toString('ascii', offset, offset + 4) !== 'OggS') break;
    const version = buffer[offset + 4];
    if (version !== 0) break;
    const numSegments = buffer[offset + 26];
    const segmentTable = buffer.slice(offset + 27, offset + 27 + numSegments);
    let dataStart = offset + 27 + numSegments;
    let pagePacket = Buffer.alloc(0);
    let continued = false;
    for (let i = 0; i < numSegments; i++) {
      const segLen = segmentTable[i];
      const seg = buffer.slice(dataStart, dataStart + segLen);
      dataStart += segLen;
      pagePacket = Buffer.concat([pagePacket, seg]);
      if (segLen < 255) {
        // End of a packet.
        if (!continued && packetBuffer.length === 0) {
          packets.push(pagePacket);
        } else {
          packets.push(Buffer.concat([packetBuffer, pagePacket]));
          packetBuffer = Buffer.alloc(0);
          packetPending = false;
        }
        pagePacket = Buffer.alloc(0);
        continued = false;
      } else {
        // Packet continues into the next page.
        packetBuffer = Buffer.concat([packetBuffer, pagePacket]);
        pagePacket = Buffer.alloc(0);
        continued = true;
        packetPending = true;
      }
    }
    if (continued || packetPending) {
      // Leftover partial packet stays buffered for the next page.
      if (pagePacket.length > 0) packetBuffer = Buffer.concat([packetBuffer, pagePacket]);
    }
    offset = dataStart;
  }
  // Drop the two Opus header packets (OpusHead, OpusTags); keep audio frames.
  const audio = packets.filter(
    (p) => !(p.slice(0, 8).toString('ascii') === 'OpusHead' || p.slice(0, 8).toString('ascii') === 'OpusTags'),
  );
  return audio;
}
