// Ed25519 signature verification for Discord Interactions.
// Discord signs every interaction POST with Ed25519 over
// (timestamp + raw body) using the application's public key.
// Uses the platform WebCrypto API (available in Workers and in Node >= 16),
// so there is no crypto dependency to vendor into the Worker bundle.
//
// Reference: Discord docs, "Validating Security Request Headers".

const encoder = new TextEncoder();

/** Hex string -> Uint8Array. Returns null on malformed input. */
export function hexToBytes(hex) {
  if (typeof hex !== 'string' || hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) {
    return null;
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/**
 * Verify a Discord interaction request.
 * @param {string} publicKeyHex - application public key (hex, from the Developer Portal)
 * @param {string} signatureHex - value of the `X-Signature-Ed25519` header
 * @param {string} timestamp - value of the `X-Signature-Timestamp` header
 * @param {Uint8Array|string} body - the raw request body, exactly as received
 * @returns {Promise<boolean>}
 */
export async function verifyDiscordRequest(publicKeyHex, signatureHex, timestamp, body) {
  const publicKeyBytes = hexToBytes(publicKeyHex);
  const signatureBytes = hexToBytes(signatureHex);
  if (!publicKeyBytes || !signatureBytes || !timestamp) return false;
  if (publicKeyBytes.length !== 32 || signatureBytes.length !== 64) return false;

  const bodyBytes = typeof body === 'string' ? encoder.encode(body) : body;
  const timestampBytes = encoder.encode(timestamp);
  const message = new Uint8Array(timestampBytes.length + bodyBytes.length);
  message.set(timestampBytes, 0);
  message.set(bodyBytes, timestampBytes.length);

  try {
    const key = await crypto.subtle.importKey(
      'raw',
      publicKeyBytes,
      { name: 'Ed25519' },
      false,
      ['verify'],
    );
    return await crypto.subtle.verify('Ed25519', key, signatureBytes, message);
  } catch {
    return false;
  }
}
