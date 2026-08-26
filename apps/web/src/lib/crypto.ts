import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from "node:crypto";

/**
 * AES-256-GCM with a key derived from APP_SECRET via HKDF-SHA256.
 * Format: `v1.<base64url iv>.<base64url ciphertext>.<base64url tag>`.
 * Used for AWS keys, Cloudflare tokens and webhook secrets at rest.
 */
export interface Cipher {
  encrypt(plaintext: string): string;
  decrypt(payload: string): string;
}

const b64u = {
  enc: (b: Buffer) => b.toString("base64url"),
  dec: (s: string) => Buffer.from(s, "base64url"),
};

export function createCipher(
  appSecret: string,
  info = "sendsprite/secrets/v1",
): Cipher {
  if (appSecret.length < 32) throw new Error("appSecret too short");
  const key = Buffer.from(
    hkdfSync("sha256", appSecret, "sendsprite", info, 32),
  );
  return {
    encrypt(plaintext) {
      const iv = randomBytes(12);
      const c = createCipheriv("aes-256-gcm", key, iv);
      const ct = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
      return `v1.${b64u.enc(iv)}.${b64u.enc(ct)}.${b64u.enc(c.getAuthTag())}`;
    },
    decrypt(payload) {
      const parts = payload.split(".");
      if (parts.length !== 4 || parts[0] !== "v1")
        throw new Error("bad ciphertext format");
      const iv = b64u.dec(parts[1]!);
      const ct = b64u.dec(parts[2]!); // may be empty: "" encrypts to no bytes
      const tag = b64u.dec(parts[3]!);
      if (iv.length !== 12 || tag.length !== 16)
        throw new Error("bad ciphertext format");
      const d = createDecipheriv("aes-256-gcm", key, iv);
      d.setAuthTag(tag);
      return Buffer.concat([d.update(ct), d.final()]).toString("utf8");
    },
  };
}

let appCipher: Cipher | undefined;
/**
 * Process-wide cipher bound to APP_SECRET. Import lazily from server code only.
 * Reads `process.env` directly rather than `@/env` because env.ts is
 * `server-only` (unimportable from tests) and validates the whole
 * environment, which this module does not need.
 */
export function getCipher(): Cipher {
  if (!appCipher) {
    const secret = process.env.APP_SECRET;
    if (!secret) throw new Error("APP_SECRET is not set");
    appCipher = createCipher(secret);
  }
  return appCipher;
}
