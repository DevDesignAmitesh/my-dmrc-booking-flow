import crypto from "node:crypto";
import { isHeaderValid } from "ondc-crypto-sdk-nodejs";
import { assertKeysConfigured, config } from "../src/config.js";
import { signRequest } from "../src/ondc/signing.js";

/**
 * Cross-checks our signing against an INDEPENDENT implementation (Node's built-in crypto, no libsodium),
 * built straight from ONDC's documented algorithm. If both agree, the header format is right.
 * Usage: pnpm check:signing
 */

assertKeysConfigured();

const priv = Buffer.from(config.signingPrivateKey, "base64"); // libsodium: 32-byte seed + 32-byte public key
const pub = Buffer.from(config.signingPublicKey, "base64");
const b64url = (b: Buffer) => b.toString("base64url");
const nodePriv = crypto.createPrivateKey({ key: { kty: "OKP", crv: "Ed25519", d: b64url(priv.subarray(0, 32)), x: b64url(pub) }, format: "jwk" });
const nodePub = crypto.createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: b64url(pub) }, format: "jwk" });

const signingString = (body: string, created: string, expires: string) =>
  `(created): ${created}\n(expires): ${expires}\ndigest: BLAKE-512=${crypto.createHash("blake2b512").update(body, "utf8").digest("base64")}`;

function independentVerify(header: string, body: string): boolean {
  const p = Object.fromEntries([...header.slice(10).matchAll(/\s*([^=,]+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
  return crypto.verify(null, Buffer.from(signingString(body, p.created, p.expires)), nodePub, Buffer.from(p.signature, "base64"));
}

function independentSign(body: string): string {
  const created = String(Math.floor(Date.now() / 1000));
  const expires = String(Number(created) + 3600);
  const sig = crypto.sign(null, Buffer.from(signingString(body, created, expires)), nodePriv).toString("base64");
  return `Signature keyId="${config.bapId}|${config.ukId}|ed25519",algorithm="ed25519",created="${created}",expires="${expires}",headers="(created) (expires) digest",signature="${sig}"`;
}

const body = JSON.stringify({ context: { action: "search", transaction_id: crypto.randomUUID() }, message: { intent: {} } });
const tampered = body.replace("search", "select");

const ourHeader = await signRequest(body);
const theirHeader = independentSign(body);

const checks: [string, boolean][] = [
  ["our header verifies with independent impl", independentVerify(ourHeader, body)],
  ["our header fails on tampered body (independent)", !independentVerify(ourHeader, tampered)],
  ["independent header verifies with ONDC SDK", await isHeaderValid({ header: theirHeader, body, publicKey: config.signingPublicKey })],
  ["independent header fails on tampered body (SDK)", !(await isHeaderValid({ header: theirHeader, body: tampered, publicKey: config.signingPublicKey }))],
  ["keyId format subscriber|ukId|ed25519", ourHeader.includes(`keyId="${config.bapId}|${config.ukId}|ed25519"`)],
];

for (const [name, ok] of checks) console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
const allOk = checks.every(([, ok]) => ok);
console.log(allOk ? "\nSigning is consistent with the ONDC spec." : "\nSigning check FAILED.");
process.exit(allOk ? 0 : 1);
