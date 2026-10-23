import crypto from "node:crypto";
import { Router, type Response } from "express";
import { config } from "./config.js";
import { sendOndc } from "./ondc/client.js";
import { buildConfirm, buildInit, buildSearchByCity, buildSearchByStations, buildSelect, buildStatus } from "./ondc/payloads.js";
import { addLog, createBooking, getBooking, type Booking, type BookingState } from "./store.js";

/**
 * What our own frontend calls. The frontend never talks ONDC: it triggers a step, then polls
 * GET /metro/txn/:id until `waitingFor` is null.
 */
export const appRouter = Router();

function load(id: string, res: Response, allowed: BookingState[]): Booking | null {
  const b = getBooking(id);
  if (!b) {
    res.status(404).json({ error: "Booking not found" });
    return null;
  }
  if (b.waitingFor) {
    res.status(409).json({ error: `Still waiting for ${b.waitingFor}` });
    return null;
  }
  if (!allowed.includes(b.state)) {
    res.status(409).json({ error: `Cannot do this in state ${b.state}` });
    return null;
  }
  return b;
}

const bad = (res: Response, error: string) => void res.status(400).json({ error });

appRouter.get("/info", (_req, res) => {
  res.json({
    bapId: config.bapId,
    domain: config.domain,
    version: config.coreVersion,
    gateway: config.gatewaySearchUrl,
    registry: config.registryLookupUrl,
    signatureCheck: config.signatureCheck,
  });
});

// 1. Start: search by city via the gateway -> every metro seller replies with its network map.
appRouter.post("/txn", async (_req, res) => {
  const b = createBooking(crypto.randomUUID());
  const ctx = await sendOndc(b, "search", buildSearchByCity(), "gateway");
  if (ctx) b.citySearchMessageId = ctx.message_id;
  res.json(b);
});

// 2. Pick seller + stations: search by station codes, sent DIRECTLY to that seller.
appRouter.post("/txn/:id/search", async (req, res) => {
  const b = load(req.params.id, res, ["STATIONS_LOADED", "OFFERED", "QUOTED"]);
  if (!b) return;
  const { bppId, from, to } = req.body as { bppId: string; from: string; to: string };
  const seller = b.sellers.find((s) => s.bppId === bppId);
  const stations = seller?.lines.flatMap((l) => l.stations) ?? [];
  const fromSt = stations.find((s) => s.code === from);
  const toSt = stations.find((s) => s.code === to);
  if (!seller || !fromSt || !toSt) return bad(res, "Unknown seller or station");

  b.seller = { bppId: seller.bppId, bppUri: seller.bppUri, providerId: seller.providerId, name: seller.name };
  b.route = { from: fromSt, to: toSt };
  b.offers = [];
  b.trip = [];
  b.selection = undefined;
  b.quote = undefined;
  await sendOndc(b, "search", buildSearchByStations(from, to), "seller");
  res.json(b);
});

// 3. Ticket type + passengers -> firm quote (one TICKET fulfillment per passenger).
appRouter.post("/txn/:id/select", async (req, res) => {
  const b = load(req.params.id, res, ["OFFERED", "QUOTED"]);
  if (!b) return;
  const { itemId, count } = req.body as { itemId: string; count: number };
  const offer = b.offers.find((o) => o.itemId === itemId);
  if (!offer) return bad(res, "Unknown ticket type");
  if (!(count >= offer.minCount && count <= offer.maxCount)) return bad(res, `Passengers must be ${offer.minCount}-${offer.maxCount}`);
  b.selection = { itemId, count };
  await sendOndc(b, "select", buildSelect(b.seller!.providerId, itemId, count), "seller");
  res.json(b);
});

// 4. Billing details + our payment proposal -> seller's payment terms.
appRouter.post("/txn/:id/init", async (req, res) => {
  const b = load(req.params.id, res, ["QUOTED"]);
  if (!b || !b.selection || !b.quote) return;
  const { name, phone, email } = req.body as { name: string; phone: string; email?: string };
  if (!name || !phone) return bad(res, "Name and phone are required");
  b.billing = { name, phone, ...(email ? { email } : {}) };
  await sendOndc(b, "init", buildInit(b.seller!.providerId, b.selection.itemId, b.selection.count, b.billing, b.quote.total), "seller");
  res.json(b);
});

// 5. Take payment (FAKE gateway), then confirm. The QR only ever comes from on_confirm.
//    Real: create gateway order -> rider pays -> verify on server (signature/webhook) -> THEN confirm.
appRouter.post("/txn/:id/pay", async (req, res) => {
  const b = load(req.params.id, res, ["INITIALIZED"]);
  if (!b || !b.payment || !b.selection || !b.billing) return;
  if (b.payment.collectedBy !== "BAP") return bad(res, `Seller requires collected_by=${b.payment.collectedBy}; not supported yet`);

  const gatewayRef = `FAKEPAY-${crypto.randomBytes(5).toString("hex").toUpperCase()}`;
  b.payment = { ...b.payment, status: "PAID", gatewayRef };
  b.state = "PAYMENT_DONE";
  addLog(b, { dir: "in", action: "payment (fake gateway)", note: `PAID INR ${b.payment.amount}, ref ${gatewayRef}` });

  await sendOndc(
    b,
    "confirm",
    buildConfirm(b.seller!.providerId, b.selection.itemId, b.selection.count, b.billing, {
      id: b.payment.id,
      amount: b.payment.amount,
      gatewayTransactionId: gatewayRef,
      tags: b.payment.tags,
    }),
    "seller",
  );
  res.json(b);
});

// 6. Refresh the order/tickets from the seller.
appRouter.post("/txn/:id/status", async (req, res) => {
  const b = load(req.params.id, res, ["CONFIRMED"]);
  if (!b || !b.order) return;
  await sendOndc(b, "status", buildStatus(b.order.id), "seller");
  res.json(b);
});

appRouter.get("/txn/:id", (req, res) => {
  const b = getBooking(req.params.id);
  if (!b) {
    res.status(404).json({ error: "Booking not found" });
    return;
  }
  res.json(b);
});
