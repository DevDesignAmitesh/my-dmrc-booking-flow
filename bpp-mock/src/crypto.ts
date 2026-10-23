import crypto from "node:crypto";
import sodium from "libsodium-wrappers";
import { createAuthorizationHeader, isHeaderValid } from "ondc-crypto-sdk-nodejs";

// Same primitives real ONDC participants use: ed25519 (libsodium format) for signing,
// X25519 (DER) + AES-256-ECB for the registry's on_subscribe challenge.

export interface SigningKeys {
  privateKey: string; // base64, 64-byte libsodium secret key
  publicKey: string; // base64, 32 bytes
}

export async function generateSigningKeys(): Promise<SigningKeys> {
  await sodium.ready;
  const kp = sodium.crypto_sign_keypair();
  return {
    privateKey: sodium.to_base64(kp.privateKey, sodium.base64_variants.ORIGINAL),
    publicKey: sodium.to_base64(kp.publicKey, sodium.base64_variants.ORIGINAL),
  };
}

export function signHeader(body: string, subscriberId: string, ukId: string, privateKey: string) {
  return createAuthorizationHeader({ body, privateKey, subscriberId, subscriberUniqueKeyId: ukId });
}

export interface ParsedAuth {
  subscriberId: string;
  ukId: string;
  created: number;
  expires: number;
}

export function parseAuthHeader(header: string | undefined): ParsedAuth | null {
  if (!header?.startsWith("Signature ")) return null;
  const parts: Record<string, string> = {};
  for (const m of header.slice("Signature ".length).matchAll(/\s*([^=,]+)="([^"]*)"/g)) parts[m[1]] = m[2];
  const [subscriberId, ukId, alg] = (parts.keyId ?? "").split("|");
  if (!subscriberId || !ukId || alg !== "ed25519" || !parts.signature) return null;
  return { subscriberId, ukId, created: Number(parts.created), expires: Number(parts.expires) };
}

/** Full check: header well-formed, not expired, signature valid for this exact body. */
export async function verifySignature(header: string | undefined, body: string, publicKey: string): Promise<string | null> {
  const parsed = parseAuthHeader(header);
  if (!parsed) return "Missing or malformed Authorization header";
  const now = Math.floor(Date.now() / 1000);
  if (!(parsed.created <= now + 60 && now <= parsed.expires)) return "Signature expired or not yet valid";
  const ok = await isHeaderValid({ header: header!, body, publicKey });
  return ok ? null : "Signature does not match body";
}

export async function verifyDetached(message: string, signatureB64: string, publicKeyB64: string): Promise<boolean> {
  await sodium.ready;
  try {
    return sodium.crypto_sign_verify_detached(
      sodium.from_base64(signatureB64, sodium.base64_variants.ORIGINAL),
      message,
      sodium.from_base64(publicKeyB64, sodium.base64_variants.ORIGINAL),
    );
  } catch {
    return false;
  }
}

export function encryptChallenge(plain: string, ourPrivateDerB64: string, theirPublicDerB64: string): string {
  const sharedKey = crypto.diffieHellman({
    privateKey: crypto.createPrivateKey({ key: Buffer.from(ourPrivateDerB64, "base64"), format: "der", type: "pkcs8" }),
    publicKey: crypto.createPublicKey({ key: Buffer.from(theirPublicDerB64, "base64"), format: "der", type: "spki" }),
  });
  const cipher = crypto.createCipheriv("aes-256-ecb", sharedKey, null);
  return Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]).toString("base64");
}
