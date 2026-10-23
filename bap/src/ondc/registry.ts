import { config } from "../config.js";
import { signRequest } from "./signing.js";

/**
 * Registry lookup (POST /v2.0/lookup, signed). Returns participants' public keys.
 * Field names follow the registry record format; confirm against ONDC SwaggerHub
 * "ONDC-Registry-Onboarding" when onboarding to pre-prod.
 */

export interface RegistryRecord {
  subscriber_id: string;
  ukId: string;
  type?: string;
  domain?: string;
  subscriber_url?: string;
  signing_public_key: string;
  encr_public_key?: string;
  valid_from?: string;
  valid_until?: string;
  status?: string;
}

export async function lookup(query: Record<string, string>): Promise<RegistryRecord[]> {
  const body = JSON.stringify({ country: config.country, domain: config.domain, ...query });
  const res = await fetch(config.registryLookupUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: await signRequest(body) },
    body,
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`lookup HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = await res.json();
  return Array.isArray(json) ? json : [];
}

const TTL_MS = 10 * 60 * 1000;
const cache = new Map<string, { key: string; at: number }>();

export async function getSigningPublicKey(subscriberId: string, ukId: string, fresh = false): Promise<string | undefined> {
  const k = `${subscriberId}|${ukId}`;
  const hit = cache.get(k);
  if (!fresh && hit && Date.now() - hit.at < TTL_MS) return hit.key;

  const records = await lookup({ subscriber_id: subscriberId });
  const rec = records.find((r) => r.ukId === ukId && (!r.valid_until || new Date(r.valid_until) > new Date()));
  if (!rec) {
    cache.delete(k);
    return undefined;
  }
  cache.set(k, { key: rec.signing_public_key, at: Date.now() });
  return rec.signing_public_key;
}
