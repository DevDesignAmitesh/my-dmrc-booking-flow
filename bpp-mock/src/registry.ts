import crypto from "node:crypto";
import fs from "node:fs";
import { Router, type Request } from "express";
import { encryptChallenge, parseAuthHeader, verifyDetached, verifySignature } from "./crypto.js";

/**
 * Mock ONDC registry: the network's phone book of participants and their public keys.
 *
 *   POST /registry/subscribe     onboarding, the same checks the real registry does:
 *                                  1. schema  2. site verification (signed request_id)  3. encrypted challenge
 *                                  to <subscriber>/<callback_url>/on_subscribe  4. publish keys
 *   POST /registry/v2.0/lookup   signed lookup of participants' public keys
 *
 * Real: https://preprod.registry.ondc.org/ondc/subscribe and /v2.0/lookup (also checks SSL/OCSP + whitelisting).
 */

// Fixed on purpose: plays the role of ONDC's *published* registry encryption public key.
// The BAP's ONDC_PUBLIC_KEY must equal MOCK_REGISTRY_ENC_PUBLIC for the local profile.
export const MOCK_REGISTRY_ENC_PRIVATE = "MC4CAQAwBQYDK2VuBCIEIEBE3uryAJ/SpVHjc/V26l2qrjNjwEuKTErqWiLimrt7";
export const MOCK_REGISTRY_ENC_PUBLIC = "MCowBQYDK2VuAyEAXfvDTRUhUnbEk88VLF7VYiJE405d+QfBdJYa28ZuxWc=";

export interface RegistryRecord {
  subscriber_id: string;
  ukId: string;
  br_id: string;
  type: "BAP" | "BPP";
  domain: string;
  country: string;
  city: string;
  subscriber_url: string;
  signing_public_key: string;
  encr_public_key: string;
  valid_from: string;
  valid_until: string;
  status: "SUBSCRIBED";
  created: string;
  updated: string;
}

const DATA_FILE = new URL("../.data/registry.json", import.meta.url);
let records: RegistryRecord[] = [];
try {
  records = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
} catch {
  records = [];
}

function persist() {
  // Only externally subscribed participants (our BAP) survive restarts; mock sellers re-register on boot.
  fs.mkdirSync(new URL("../.data/", import.meta.url), { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(records.filter((r) => r.type === "BAP"), null, 2));
}

export function upsertRecord(rec: RegistryRecord, save = false) {
  records = records.filter((r) => !(r.subscriber_id === rec.subscriber_id && r.ukId === rec.ukId && r.domain === rec.domain));
  records.push(rec);
  if (save) persist();
}

export function findKey(subscriberId: string, ukId: string): RegistryRecord | undefined {
  return records.find((r) => r.subscriber_id === subscriberId && r.ukId === ukId);
}

/** Verify a request signed by any registered participant; returns the signer record or an error. */
export async function verifyFromRegistry(req: Request): Promise<{ signer?: RegistryRecord; error?: string }> {
  const header = req.header("authorization");
  const parsed = parseAuthHeader(header);
  if (!parsed) return { error: "Missing or malformed Authorization header" };
  const signer = findKey(parsed.subscriberId, parsed.ukId);
  if (!signer) return { error: `Unknown subscriber ${parsed.subscriberId}|${parsed.ukId} (not in registry: run \`pnpm subscribe --send\`)` };
  const err = await verifySignature(header, (req as any).rawBody ?? "", signer.signing_public_key);
  return err ? { error: err } : { signer };
}

const nack = (code: string, message: string) => ({ message: { ack: { status: "NACK" } }, error: { type: "POLICY-ERROR", code, path: null, message } });

/** Real subscriber_id is an FQDN served over https; locally we allow localhost:port over http. */
const subscriberBase = (id: string) => (/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(id) ? `http://${id}` : `https://${id}`);
const joinPath = (base: string, ...p: string[]) => base + ("/" + p.join("/")).replace(/\/+/g, "/").replace(/\/$/, "");

export const registryRouter = Router();

registryRouter.post("/subscribe", async (req, res) => {
  const body = req.body ?? {};
  const opsNo = body.context?.operation?.ops_no;
  const msg = body.message ?? {};
  const entity = msg.entity ?? {};
  const keyPair = entity.key_pair ?? {};
  const nps: any[] = msg.network_participant ?? [];

  // 1. schema (subset of the real checks)
  const missing = [
    [opsNo, "context.operation.ops_no"],
    [msg.request_id, "message.request_id"],
    [entity.subscriber_id, "entity.subscriber_id"],
    [entity.unique_key_id, "entity.unique_key_id"],
    [entity.callback_url, "entity.callback_url"],
    [keyPair.signing_public_key, "entity.key_pair.signing_public_key"],
    [keyPair.encryption_public_key, "entity.key_pair.encryption_public_key"],
    [nps.length || undefined, "message.network_participant[]"],
  ].filter(([v]) => v === undefined || v === null || v === "").map(([, k]) => k);
  if (missing.length) return void res.status(400).json(nack("1050", `Schema: missing ${missing.join(", ")}`));
  if (![1, 2, 4].includes(Number(opsNo))) return void res.status(400).json(nack("1050", "Unsupported ops_no (use 1 for buyer app)"));

  const base = subscriberBase(entity.subscriber_id);
  console.log(`[registry] subscribe from ${entity.subscriber_id} (ops_no ${opsNo})`);

  // 2. domain verification: https://<subscriber_id>/ondc-site-verification.html must hold sign(request_id)
  try {
    const html = await (await fetch(`${base}/ondc-site-verification.html`, { signal: AbortSignal.timeout(5000) })).text();
    const signed = html.match(/name=['"]ondc-site-verification['"]\s+content=['"]([^'"]+)['"]/)?.[1];
    if (!signed) return void res.json(nack("1051", "ondc-site-verification.html: meta tag not found"));
    if (!(await verifyDetached(msg.request_id, signed, keyPair.signing_public_key)))
      return void res.json(nack("1052", "ondc-site-verification.html: signature does not verify against request_id + signing_public_key"));
    console.log("[registry]   site verification OK");
  } catch (e) {
    return void res.json(nack("1051", `Could not fetch ${base}/ondc-site-verification.html: ${(e as Error).message}`));
  }

  // 3. challenge: encrypt with shared key (our X25519 private + their encryption public), they must decrypt it
  const challenge = crypto.randomBytes(16).toString("hex");
  try {
    const encrypted = encryptChallenge(challenge, MOCK_REGISTRY_ENC_PRIVATE, keyPair.encryption_public_key);
    const r = await fetch(joinPath(base, entity.callback_url, "on_subscribe"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subscriber_id: entity.subscriber_id, challenge: encrypted }),
      signal: AbortSignal.timeout(5000),
    });
    const answer = ((await r.json().catch(() => ({}))) as { answer?: string }).answer;
    if (answer !== challenge) return void res.json(nack("1053", "on_subscribe: wrong challenge answer"));
    console.log("[registry]   on_subscribe challenge OK");
  } catch (e) {
    return void res.json(nack("1053", `on_subscribe call failed: ${(e as Error).message}`));
  }

  // 4. publish
  const now = new Date().toISOString();
  for (const np of nps) {
    upsertRecord(
      {
        subscriber_id: entity.subscriber_id,
        ukId: String(entity.unique_key_id),
        br_id: crypto.randomUUID(),
        type: Number(opsNo) === 2 ? "BPP" : "BAP",
        domain: np.domain,
        country: entity.country ?? "IND",
        city: (np.city_code ?? []).join(","),
        subscriber_url: joinPath(base, np.subscriber_url ?? "/"),
        signing_public_key: keyPair.signing_public_key,
        encr_public_key: keyPair.encryption_public_key,
        valid_from: keyPair.valid_from ?? now,
        valid_until: keyPair.valid_until ?? new Date(Date.now() + 365 * 864e5).toISOString(),
        status: "SUBSCRIBED",
        created: now,
        updated: now,
      },
      true,
    );
  }
  console.log(`[registry]   ${entity.subscriber_id} SUBSCRIBED`);
  res.json({ message: { ack: { status: "ACK" } }, error: { type: null, code: null, path: null, message: null } });
});

registryRouter.post("/v2.0/lookup", async (req, res) => {
  const { error } = await verifyFromRegistry(req);
  if (error) return void res.status(401).json(nack("1001", `Lookup auth failed: ${error}`));
  const q = req.body ?? {};
  const out = records.filter(
    (r) =>
      (!q.subscriber_id || r.subscriber_id === q.subscriber_id) &&
      (!q.ukId || r.ukId === q.ukId) &&
      (!q.type || r.type === q.type) &&
      (!q.domain || r.domain === q.domain) &&
      (!q.country || r.country === q.country),
  );
  res.json(out);
});
