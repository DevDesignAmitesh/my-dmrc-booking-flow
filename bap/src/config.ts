// All network-specific values live here. Defaults = local mock network (bpp-mock on :4001).
// Pre-prod values: see .env.preprod.example.

const PORT = Number(process.env.PORT ?? 4000);
const env = (name: string, fallback = "") => process.env[name] ?? fallback;

// The mock registry's fixed encryption key (bpp-mock/src/registry.ts). Real ONDC publishes its own per environment.
const MOCK_REGISTRY_PUBLIC_KEY = "MCowBQYDK2VuAyEAXfvDTRUhUnbEk88VLF7VYiJE405d+QfBdJYa28ZuxWc=";

const bapUri = env("BAP_URI", `http://localhost:${PORT}/ondc`);

export const config = {
  port: PORT,

  // Identity on the network. Real: subscriber_id is your FQDN, e.g. ondc.macrorides.com
  bapId: env("BAP_ID", `localhost:${PORT}`),
  bapUri, // where sellers POST on_* callbacks
  callbackPath: new URL(bapUri).pathname.replace(/\/$/, "") || "/",

  // Keys (from `pnpm keys` -> bap/.env.keys). Never commit these.
  ukId: env("UNIQUE_KEY_ID"),
  signingPrivateKey: env("SIGNING_PRIVATE_KEY"),
  signingPublicKey: env("SIGNING_PUBLIC_KEY"),
  encryptionPrivateKey: env("ENCRYPTION_PRIVATE_KEY"),
  encryptionPublicKey: env("ENCRYPTION_PUBLIC_KEY"),
  requestId: env("REQUEST_ID"), // signed into ondc-site-verification.html

  // Network endpoints
  gatewaySearchUrl: env("GATEWAY_SEARCH_URL", "http://localhost:4001/gateway/search"),
  registryLookupUrl: env("REGISTRY_LOOKUP_URL", "http://localhost:4001/registry/v2.0/lookup"),
  registrySubscribeUrl: env("REGISTRY_SUBSCRIBE_URL", "http://localhost:4001/registry/subscribe"),
  ondcPublicKey: env("ONDC_PUBLIC_KEY", MOCK_REGISTRY_PUBLIC_KEY), // registry's X25519 key for on_subscribe

  // Protocol
  domain: "ONDC:TRV11",
  coreVersion: "2.0.1",
  country: "IND",
  cityCode: env("CITY_CODE", "std:011"),
  callbackTimeoutMs: Number(env("CALLBACK_TIMEOUT_MS", "30000")),
  signatureCheck: env("SIGNATURE_CHECK", "on") !== "off",

  // Commercial terms we propose (real values come from the ONDC/seller agreement)
  buyerFinderFeePercent: env("BUYER_FINDER_FEES_PERCENTAGE", "1"),
  staticTermsUrl: env("STATIC_TERMS_URL", `http://localhost:${PORT}/terms`),
};

export function assertKeysConfigured() {
  const missing = ["UNIQUE_KEY_ID", "SIGNING_PRIVATE_KEY", "SIGNING_PUBLIC_KEY", "ENCRYPTION_PRIVATE_KEY", "ENCRYPTION_PUBLIC_KEY", "REQUEST_ID"].filter(
    (k) => !process.env[k],
  );
  if (missing.length) {
    console.error(`[bap] Missing keys: ${missing.join(", ")}.\n[bap] Run \`pnpm keys\` (creates bap/.env.keys), then restart.`);
    process.exit(1);
  }
}
