import fs from "node:fs";
import { assertKeysConfigured, config } from "../src/config.js";

/**
 * Steps 8-10 of ONDC onboarding: build (and optionally send) our /subscribe request as a buyer app (ops_no 1).
 * The BAP must be running and reachable at https://<subscriber_id> so the registry can fetch
 * ondc-site-verification.html and call <callback_url>/on_subscribe.
 *
 * Usage: pnpm subscribe            dry run: print the payload
 *        pnpm subscribe --send     POST it to REGISTRY_SUBSCRIBE_URL
 *
 * Payload shape follows ONDC SwaggerHub "ONDC-Registry-Onboarding" 2.0.5 (ops_no_1 example) as best known;
 * re-check it there before sending to pre-prod.
 */

assertKeysConfigured();

const entityFile = ["../onboarding/entity.json", "../onboarding/entity.example.json"]
  .map((p) => new URL(p, import.meta.url))
  .find((u) => fs.existsSync(u))!;
if (entityFile.pathname.endsWith("entity.example.json"))
  console.warn("! Using onboarding/entity.example.json (placeholder company details). Copy it to entity.json and fill it in for real onboarding.\n");
const entity = JSON.parse(fs.readFileSync(entityFile, "utf8"));

const now = new Date();
const payload = {
  context: { operation: { ops_no: 1 } },
  message: {
    request_id: config.requestId,
    timestamp: now.toISOString(),
    entity: {
      ...entity,
      country: config.country,
      subscriber_id: config.bapId,
      unique_key_id: config.ukId,
      callback_url: config.callbackPath,
      key_pair: {
        signing_public_key: config.signingPublicKey,
        encryption_public_key: config.encryptionPublicKey,
        valid_from: now.toISOString(),
        valid_until: new Date(now.getTime() + 365 * 864e5).toISOString(),
      },
    },
    network_participant: [
      {
        subscriber_url: config.callbackPath,
        domain: config.domain,
        type: "buyerApp",
        msn: false,
        city_code: [config.cityCode],
      },
    ],
  },
};

console.log(JSON.stringify(payload, null, 2));

if (!process.argv.includes("--send")) {
  console.log(`\n(dry run) Re-run with --send to POST to ${config.registrySubscribeUrl}`);
  process.exit(0);
}

console.log(`\nPOST ${config.registrySubscribeUrl} ...`);
const res = await fetch(config.registrySubscribeUrl, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(payload),
});
const text = await res.text();
console.log(`HTTP ${res.status}\n${text}`);
const ok = (() => {
  try {
    return JSON.parse(text)?.message?.ack?.status === "ACK";
  } catch {
    return false;
  }
})();
console.log(ok ? "\nSubscribed. Our keys are now in the registry." : "\nSubscribe failed: see the error above.");
process.exit(ok ? 0 : 1);
