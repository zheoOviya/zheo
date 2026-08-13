import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

// ============================================
// RFC 6238 TOTP (authenticator-app 2FA)
// Pure node:crypto implementation (no external deps):
//  - 160-bit random secret, base32 encoded (Google Authenticator format)
//  - HMAC-SHA1, 30s step, 6 digits, optional leading-zero padding
//  - Verification tolerates +/- 1 time step (clock drift / in-flight codes)
//  - otpauth:// URL for QR enrollment
// ============================================

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const TOTP_STEP_SECONDS = 30;
const TOTP_DIGITS = 6;
const WINDOW_STEPS = 1;
const SECRET_BYTES = 20; // 160 bits

export function generateTotpSecret(): string {
  return base32Encode(randomBytes(SECRET_BYTES));
}

/** `otpauth://` URI consumed by authenticator apps + QR generators. */
export function buildOtpauthUrl(
  secret: string,
  label: string,
  issuer = "SnakZap",
): string {
  const encodedLabel = encodeURIComponent(`${issuer}:${label}`);
  const query = new URLSearchParams({
    secret,
    issuer,
    algorithm: "SHA1",
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_SECONDS),
  });
  return `otpauth://totp/${encodedLabel}?${query.toString()}`;
}

/** Current TOTP code for the given secret at `now` (defaults to now). */
export function generateTotpCode(secret: string, now = Date.now()): string {
  const counter = Math.floor(now / 1000 / TOTP_STEP_SECONDS);
  const hash = hmacSha1(base32Decode(secret), bigEndianUint64(counter));
  const offset = hash[hash.length - 1]! & 0x0f;
  const truncated =
    ((hash[offset]! & 0x7f) << 24) |
    ((hash[offset + 1]! & 0xff) << 16) |
    ((hash[offset + 2]! & 0xff) << 8) |
    (hash[offset + 3]! & 0xff);
  return String(truncated % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, "0");
}

/**
 * Verify a TOTP code within a +/- WINDOW_STEPS time-step tolerance.
 * Codes are compared with a timing-safe constant-time equality.
 */
export function verifyTotpCode(
  secret: string,
  code: string,
  now = Date.now(),
): boolean {
  if (!/^[0-9]{6}$/.test(code)) return false;
  for (let step = -WINDOW_STEPS; step <= WINDOW_STEPS; step += 1) {
    const candidate = generateTotpCode(
      secret,
      now + step * TOTP_STEP_SECONDS * 1000,
    );
    if (safeEqual(candidate, code)) return true;
  }
  return false;
}

function hmacSha1(key: Uint8Array, message: Uint8Array): Uint8Array {
  return new Uint8Array(createHmac("sha1", key).update(message).digest());
}

function bigEndianUint64(value: number): Uint8Array {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(value));
  return new Uint8Array(buf);
}

function safeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

function base32Decode(input: string): Uint8Array {
  const cleaned = input.toUpperCase().replace(/=+$/g, "");
  const bytes: number[] = [];
  let buffer = 0;
  let bitsLeft = 0;
  for (const char of cleaned) {
    const value = BASE32_ALPHABET.indexOf(char);
    if (value === -1) continue;
    buffer = (buffer << 5) | value;
    bitsLeft += 5;
    if (bitsLeft >= 8) {
      bytes.push((buffer >>> (bitsLeft - 8)) & 0xff);
      bitsLeft -= 8;
    }
  }
  return new Uint8Array(bytes);
}
