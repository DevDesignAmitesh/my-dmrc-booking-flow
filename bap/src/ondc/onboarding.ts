import crypto from "node:crypto";
import type { Request, Response } from "express";
import { config } from "../config.js";
import { signPlain } from "./signing.js";

/**
 * Registry onboarding endpoints (ONDC developer-docs, "Onboarding of Participants"):
 *
 *   GET  https://<subscriber_id>/ondc-site-verification.html
 *        -> meta tag holding ed25519 signature (no hashing) of REQUEST_ID. Proves we control the domain.
 *   POST https://<subscriber_id><callback_url>/on_subscribe   { subscriber_id, challenge }
 *        -> decrypt the challenge with AES-256-ECB using the X25519 shared key
 *           (our ENCRYPTION_PRIVATE_KEY + the registry's ONDC_PUBLIC_KEY); reply { answer } synchronously.
 */

export async function siteVerification(_req: Request, res: Response) {
  const signed = await signPlain(config.requestId);
  res.type("html").send(`<html>
  <head>
    <meta name='ondc-site-verification' content='${signed}' />
  </head>
  <body>
    ONDC Site Verification Page
  </body>
</html>
`);
}

let sharedKey: Buffer | null = null;
function getSharedKey(): Buffer {
  sharedKey ??= crypto.diffieHellman({
    privateKey: crypto.createPrivateKey({ key: Buffer.from(config.encryptionPrivateKey, "base64"), format: "der", type: "pkcs8" }),
    publicKey: crypto.createPublicKey({ key: Buffer.from(config.ondcPublicKey, "base64"), format: "der", type: "spki" }),
  });
  return sharedKey;
}

export function onSubscribe(req: Request, res: Response) {
  const { subscriber_id, challenge } = (req.body ?? {}) as { subscriber_id?: string; challenge?: string };
  if (subscriber_id !== config.bapId || !challenge) {
    res.status(400).json({ error: "Unexpected subscriber_id or missing challenge" });
    return;
  }
  try {
    const decipher = crypto.createDecipheriv("aes-256-ecb", getSharedKey(), null);
    const answer = decipher.update(challenge, "base64", "utf8") + decipher.final("utf8");
    console.log("[bap] on_subscribe: challenge decrypted");
    res.json({ answer });
  } catch (e) {
    console.error(`[bap] on_subscribe: could not decrypt challenge: ${(e as Error).message}`);
    res.status(400).json({ error: "Could not decrypt challenge (wrong ONDC_PUBLIC_KEY for this registry?)" });
  }
}
