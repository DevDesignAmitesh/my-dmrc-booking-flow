import express, { type Request } from "express";
import { registryRouter, verifyFromRegistry } from "./registry.js";
import { SELLERS } from "./network-data.js";
import { createSeller, type MockOptions, type Seller } from "./seller.js";

/**
 * Mock ONDC network for local development. Throwaway: replaced by real ONDC pre-prod.
 *
 *   /registry/*       mock registry (subscribe + v2.0/lookup)
 *   /gateway/search   mock gateway: verifies the BAP signature, broadcasts to every seller
 *   /<seller>/*       mock seller apps (BPPs), e.g. /dmrc, /nmrc
 */

const PORT = Number(process.env.PORT ?? 4001);
const opts: MockOptions = {
  baseUrl: process.env.BASE_URL ?? `http://localhost:${PORT}`,
  delayMs: Number(process.env.MOCK_DELAY_MS ?? 800),
  dropActions: new Set((process.env.MOCK_DROP_ACTIONS ?? "").split(",").filter(Boolean)),
};
const sellerKeys = (process.env.MOCK_SELLERS ?? "dmrc").split(",").map((s) => s.trim()).filter(Boolean);

const app = express();
// Keep the exact bytes: signatures are over the raw body, not re-serialised JSON.
app.use(express.json({ verify: (req, _res, buf) => void ((req as Request & { rawBody?: string }).rawBody = buf.toString("utf8")) }));

const sellers: Seller[] = [];
for (const key of sellerKeys) {
  const data = SELLERS[key];
  if (!data) throw new Error(`Unknown MOCK_SELLERS entry "${key}" (known: ${Object.keys(SELLERS).join(", ")})`);
  const seller = await createSeller(data, opts);
  sellers.push(seller);
  app.use(`/${key}`, seller.router);
}

app.use("/registry", registryRouter);

app.post("/gateway/search", async (req, res) => {
  const ctx = req.body?.context ?? {};
  const { signer, error } = await verifyFromRegistry(req);
  if (error || signer?.subscriber_id !== ctx.bap_id) {
    console.log(`[gateway] search REJECTED: ${error ?? "signer is not context.bap_id"}`);
    return void res.status(401).json({ message: { ack: { status: "NACK" } }, error: { code: "10001", message: `Invalid Signature: ${error ?? "signer mismatch"}` } });
  }
  if (ctx.action !== "search" || ctx.domain !== "ONDC:TRV11")
    return void res.status(400).json({ message: { ack: { status: "NACK" } }, error: { code: "10000", message: "Gateway only routes ONDC:TRV11 search here" } });

  console.log(`[gateway] <- search txn=${ctx.transaction_id} -> broadcasting to ${sellers.map((s) => s.data.key).join(", ")}`);
  res.json({ message: { ack: { status: "ACK" } } });
  for (const s of sellers) s.acceptForwardedSearch(req.body);
});

app.listen(PORT, () => {
  console.log(`[mock-network] on ${opts.baseUrl} (delay ${opts.delayMs}ms)`);
  console.log(`[mock-network]   registry  ${opts.baseUrl}/registry/subscribe | /registry/v2.0/lookup`);
  console.log(`[mock-network]   gateway   ${opts.baseUrl}/gateway/search`);
  for (const s of sellers) console.log(`[mock-network]   seller    ${s.bppId} at ${s.bppUri}`);
});
