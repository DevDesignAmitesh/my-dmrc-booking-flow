import { createAuthorizationHeader, isHeaderValid, signMessage } from "ondc-crypto-sdk-nodejs";
import { config } from "../config.js";
import { getSigningPublicKey } from "./registry.js";

/**
 * ONDC request signing via the official SDK (ondc-crypto-sdk-nodejs):
 *   digest  = BLAKE2b-512(raw body), signing string = "(created)…(expires)…digest: BLAKE-512=…", ed25519.
 *   Authorization: Signature keyId="<subscriber_id>|<ukId>|ed25519",algorithm="ed25519",created,expires,headers,signature
 * Always sign/verify the exact bytes that go on the wire.
 */

export function signRequest(rawBody: string): Promise<string> {
  return createAuthorizationHeader({
    body: rawBody,
    privateKey: config.signingPrivateKey,
    subscriberId: config.bapId,
    subscriberUniqueKeyId: config.ukId,
  });
}

/** Plain ed25519 signature of a string, no hashing (used for ondc-site-verification.html). */
export function signPlain(text: string): Promise<string> {
  return signMessage({ signingString: text, privateKey: config.signingPrivateKey });
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

export type SignatureCheck = { status: "verified"; signer: string } | { status: "failed"; reason: string } | { status: "skipped" };

/**
 * Verify an incoming request: header well-formed, signer is who the context claims, not expired,
 * and the signature matches this body under the signer's registry public key.
 */
export async function verifyIncoming(rawBody: string, header: string | undefined, expectedSigner: string | undefined): Promise<SignatureCheck> {
  if (!config.signatureCheck) return { status: "skipped" };
  const parsed = parseAuthHeader(header);
  if (!parsed) return { status: "failed", reason: "Missing or malformed Authorization header" };
  if (expectedSigner && parsed.subscriberId !== expectedSigner)
    return { status: "failed", reason: `Signed by ${parsed.subscriberId}, but context says ${expectedSigner}` };
  const now = Math.floor(Date.now() / 1000);
  if (!(parsed.created <= now + 60 && now <= parsed.expires)) return { status: "failed", reason: "Signature expired or not yet valid" };

  // Try the cached key first; if it fails, refetch once (the sender may have rotated keys).
  for (const fresh of [false, true]) {
    let publicKey: string | undefined;
    try {
      publicKey = await getSigningPublicKey(parsed.subscriberId, parsed.ukId, fresh);
    } catch (e) {
      return { status: "failed", reason: `Registry lookup failed: ${(e as Error).message}` };
    }
    if (!publicKey) return { status: "failed", reason: `${parsed.subscriberId}|${parsed.ukId} not found in registry` };
    if (await isHeaderValid({ header: header!, body: rawBody, publicKey })) return { status: "verified", signer: parsed.subscriberId };
  }
  return { status: "failed", reason: "Signature does not match body" };
}
