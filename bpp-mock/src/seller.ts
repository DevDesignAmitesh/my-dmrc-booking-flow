import crypto from "node:crypto";
import { Router } from "express";
import { generateSigningKeys, signHeader, type SigningKeys } from "./crypto.js";
import { allStations, findPath, isInterchange, sjtFare, stationName, type SellerData } from "./network-data.js";
import { upsertRecord, verifyFromRegistry } from "./registry.js";

/**
 * One mock seller app (BPP), e.g. DMRC. Mirrors the TRV11 2.0.1 examples
 * (ONDC-Official/mobility-specification @ release-TRV11-2.0.1, api/components/examples/metro).
 */

export interface MockOptions {
  baseUrl: string; // e.g. http://localhost:4001
  delayMs: number;
  dropActions: Set<string>;
}

type Body = { context: Record<string, any>; message: Record<string, any> };
type Result = { message?: Record<string, any>; error?: { code: string; message: string } };

interface TxnState {
  from?: string;
  to?: string;
  path?: string[];
  items?: Record<string, any>[];
  bffPercent?: string;
  itemId?: string;
  count?: number;
  billing?: Record<string, any>;
  payment?: Record<string, any>;
  order?: Record<string, any>;
  confirmCtx?: Record<string, any>; // context of the BAP's confirm: where to push unsolicited updates
}

const VERSION = "2.0.1";
const tag = (code: string, list: [string, string][], display?: boolean) => ({
  descriptor: { code },
  ...(display === undefined ? {} : { display }),
  list: list.map(([c, value]) => ({ descriptor: { code: c }, value })),
});

export interface Seller {
  data: SellerData;
  bppId: string;
  bppUri: string;
  router: Router;
  /** Entry point for searches forwarded by the gateway (already signature-checked there). */
  acceptForwardedSearch(body: Body): void;
}

export async function createSeller(data: SellerData, opts: MockOptions): Promise<Seller> {
  const bppId = `${data.key}.mock-network.local`;
  const bppUri = `${opts.baseUrl}/${data.key}`;
  const ukId = `${data.key}-key-1`;
  const keys: SigningKeys = await generateSigningKeys();
  const now = new Date().toISOString();
  upsertRecord({
    subscriber_id: bppId,
    ukId,
    br_id: crypto.randomUUID(),
    type: "BPP",
    domain: "ONDC:TRV11",
    country: "IND",
    city: "std:011",
    subscriber_url: bppUri,
    signing_public_key: keys.publicKey,
    encr_public_key: "",
    valid_from: now,
    valid_until: new Date(Date.now() + 365 * 864e5).toISOString(),
    status: "SUBSCRIBED",
    created: now,
    updated: now,
  });

  const txns = new Map<string, TxnState>();
  const ordersById = new Map<string, Record<string, any>>();
  const log = (s: string) => console.log(`[${data.key}] ${s}`);

  const provider = (withDetails = true) => ({
    id: data.providerId,
    ...(withDetails
      ? {
          descriptor: { name: data.name, images: [{ url: `${bppUri}/logo.ico` }] },
          time: { range: { start: "2026-01-01T00:00:00.000Z", end: "2027-12-31T23:59:59.000Z" } },
        }
      : {}),
  });

  const stop = (code: string, type: string, i: number, extra: Record<string, any> = {}) => ({
    type,
    id: String(i + 1),
    ...(i > 0 ? { parent_stop_id: String(i) } : {}),
    instructions: { name: `Stop ${i + 1}`, ...extra },
    location: { descriptor: { name: stationName(code), code } },
  });

  const tripFulfillment = (path: string[]) => ({
    id: "F1",
    type: "TRIP",
    stops: path.map((c, i) =>
      stop(c, i === 0 ? "START" : i === path.length - 1 ? "END" : isInterchange(data, c) ? "TRANSIT_STOP" : "INTERMEDIATE_STOP", i),
    ),
    vehicle: { category: "METRO" },
  });

  const ticketFulfillments = (count: number, issued?: { orderId: string; validTo: string; txn: TxnState }) =>
    Array.from({ length: count }, (_, n) => {
      const id = `T${n + 1}`;
      const number = crypto.createHash("sha256").update(`${issued?.orderId}-${id}`).digest("hex").slice(0, 8);
      return {
        id,
        type: "TICKET",
        ...(issued
          ? {
              stops: [
                {
                  type: "START",
                  // The QR the gate scans. Issued by the seller only; a real one may be a base64 PNG image.
                  authorization: {
                    type: "QR",
                    token: qrToken(issued.orderId, number, issued.txn, issued.validTo),
                    valid_to: issued.validTo,
                    status: "UNCLAIMED",
                  },
                },
              ],
            }
          : {}),
        tags: [tag("INFO", [["PARENT_ID", "F1"]]), ...(issued ? [tag("TICKET_INFO", [["NUMBER", number]])] : [])],
      };
    });

  function qrToken(orderId: string, number: string, t: TxnState, validTo: string) {
    const payload = [data.key.toUpperCase(), orderId, number, t.from, t.to, validTo].join("|");
    const sig = crypto.createHmac("sha256", `mock-${data.key}-qr-secret`).update(payload).digest("hex").slice(0, 16);
    return `${payload}|${sig}`;
  }

  const quoteFor = (t: TxnState) => {
    const item = t.items!.find((i) => i.id === t.itemId)!;
    const unit = Number(item.price.value);
    return {
      price: { value: String(unit * t.count!), currency: "INR" },
      breakup: [
        {
          title: "BASE_FARE",
          item: { id: item.id, price: { currency: "INR", value: String(unit) }, quantity: { selected: { count: t.count } } },
          price: { currency: "INR", value: String(unit * t.count!) },
        },
      ],
    };
  };

  const orderItems = (t: TxnState) => {
    const item = t.items!.find((i) => i.id === t.itemId)!;
    return [
      {
        ...item,
        quantity: { selected: { count: t.count } },
        fulfillment_ids: ["F1", ...Array.from({ length: t.count! }, (_, n) => `T${n + 1}`)],
      },
    ];
  };

  const cancellationTerms = [{ external_ref: { mimetype: "text/html", url: `${bppUri}/tnc.html` } }];

  const settlementTags = (t: TxnState, total: number) => {
    const bff = Number(t.bffPercent ?? "1");
    return [
      tag("BUYER_FINDER_FEES", [["BUYER_FINDER_FEES_PERCENTAGE", String(bff)]], false),
      tag(
        "SETTLEMENT_TERMS",
        [
          ["SETTLEMENT_WINDOW", "P30D"],
          ["SETTLEMENT_BASIS", "INVOICE_RECEIPT"],
          ["MANDATORY_ARBITRATION", "TRUE"],
          ["COURT_JURISDICTION", "New Delhi"],
          ["STATIC_TERMS", `${bppUri}/booking/terms`],
          ["SETTLEMENT_AMOUNT", (total * (1 - bff / 100)).toFixed(2)],
          ["SETTLEMENT_TYPE", "NEFT"],
        ],
        false,
      ),
    ];
  };

  const handlers: Record<string, (ctx: Record<string, any>, msg: Record<string, any>) => Result> = {
    search(ctx, msg) {
      const fulfillment = msg.intent?.fulfillment ?? {};
      const payment = msg.intent?.payment ?? {};
      if (fulfillment.vehicle?.category && fulfillment.vehicle.category !== "METRO") return {};
      const stops: any[] = fulfillment.stops ?? [];
      const from = stops.find((s) => s.type === "START")?.location?.descriptor?.code;
      const to = stops.find((s) => s.type === "END")?.location?.descriptor?.code;
      const bff = payment.tags?.find((t: any) => t.descriptor?.code === "BUYER_FINDER_FEES")?.list?.[0]?.value ?? "1";
      const catalogPayments = [{ collected_by: payment.collected_by ?? "BAP", tags: settlementTags({ bffPercent: bff }, 0).map((t) => ({ ...t, list: t.list.filter((l: any) => l.descriptor.code !== "SETTLEMENT_AMOUNT") })) }];
      const categories = [
        { id: "C1", descriptor: { name: "Ticket", code: "TICKET" } },
        { id: "C2", descriptor: { name: "Pass", code: "PASS" } },
      ];

      // Stage 1: search by city -> the network map (ROUTE fulfillments with every station)
      if (!from && !to) {
        return {
          message: {
            catalog: {
              descriptor: { name: data.name },
              providers: [
                {
                  ...provider(),
                  categories,
                  fulfillments: data.lines.map((l) => ({
                    id: `F-${l.routeId}`,
                    type: "ROUTE",
                    stops: l.stations.map((c, i) => {
                      const type =
                        i === 0 ? "START" : i === l.stations.length - 1 ? "END" : isInterchange(data, c) ? "TRANSIT_STOP" : "INTERMEDIATE_STOP";
                      const other = data.lines.filter((x) => x !== l && x.stations.includes(c)).map((x) => x.name);
                      return stop(c, type, i, other.length ? { short_desc: `Change for ${other.join(", ")}` } : {});
                    }),
                    vehicle: { category: "METRO" },
                    tags: [tag("ROUTE_INFO", [["ROUTE_ID", l.routeId], ["ROUTE_NAME", l.name]])],
                  })),
                  payments: catalogPayments,
                },
              ],
            },
          },
        };
      }

      // Stage 2: search by station codes -> fare products for that trip
      const known = allStations(data);
      if (!known.has(from) || !known.has(to)) return { error: { code: "92001", message: "Stop not served by this provider" } };
      if (from === to) return { error: { code: "92001", message: "START and END stops are the same" } };
      const path = findPath(data, from, to)!;
      const sjt = sjtFare(data, path.length - 1);
      const items = [
        { id: "I1", category_ids: ["C1"], descriptor: { name: "Single Journey Ticket", code: "SJT" }, price: { currency: "INR", value: String(sjt) } },
        { id: "I2", category_ids: ["C1"], descriptor: { name: "Round Journey Ticket", code: "RJT" }, price: { currency: "INR", value: String(Math.round(sjt * data.roundTripFactor)) } },
      ].map((i) => ({
        ...i,
        quantity: { maximum: { count: 6 }, minimum: { count: 1 } },
        fulfillment_ids: ["F1"],
        time: { label: "Validity", duration: i.descriptor.code === "SJT" ? "PT1D" : "PT2D" },
      }));
      txns.set(ctx.transaction_id, { from, to, path, items, bffPercent: bff });
      return {
        message: {
          catalog: {
            descriptor: { name: data.name },
            providers: [{ ...provider(), categories, items, fulfillments: [tripFulfillment(path)], payments: catalogPayments }],
          },
        },
      };
    },

    select(ctx, msg) {
      const t = txns.get(ctx.transaction_id);
      if (!t?.items) return { error: { code: "92002", message: "No search found for this transaction_id" } };
      const sel = msg.order?.items?.[0];
      const item = t.items.find((i) => i.id === sel?.id);
      const count = Number(sel?.quantity?.selected?.count);
      if (!item) return { error: { code: "92002", message: `Unknown item ${sel?.id}` } };
      if (!(count >= 1 && count <= 6)) return { error: { code: "92003", message: "Quantity must be between 1 and 6" } };
      Object.assign(t, { itemId: item.id, count });
      return {
        message: {
          order: {
            items: orderItems(t),
            provider: provider(),
            fulfillments: [tripFulfillment(t.path!), ...ticketFulfillments(count)],
            quote: quoteFor(t),
            cancellation_terms: cancellationTerms,
          },
        },
      };
    },

    init(ctx, msg) {
      const t = txns.get(ctx.transaction_id);
      if (!t?.itemId) return { error: { code: "92002", message: "No select found for this transaction_id" } };
      const proposed = msg.order?.payments?.[0] ?? {};
      if (proposed.collected_by && proposed.collected_by !== "BAP")
        return { error: { code: "92004", message: "This mock only supports BAP-collected payments" } };
      t.billing = msg.order?.billing;
      const quote = quoteFor(t);
      t.payment = {
        id: `PA-${ctx.transaction_id.slice(0, 8)}`,
        collected_by: "BAP",
        status: "NOT_PAID",
        type: "PRE_ORDER",
        params: { bank_code: "MOCK0000001", bank_account_number: "XXXXXXXX0001" },
        tags: settlementTags(t, Number(quote.price.value)),
      };
      return {
        message: {
          order: {
            items: orderItems(t),
            provider: provider(),
            fulfillments: [tripFulfillment(t.path!), ...ticketFulfillments(t.count!)],
            billing: t.billing,
            quote,
            payments: [t.payment],
            cancellation_terms: cancellationTerms,
          },
        },
      };
    },

    confirm(ctx, msg) {
      const t = txns.get(ctx.transaction_id);
      if (!t?.payment) return { error: { code: "92002", message: "No init found for this transaction_id" } };
      if (t.order) return { message: { order: t.order } }; // idempotent: same order, never a second set of tickets
      const p = msg.order?.payments?.[0] ?? {};
      const total = quoteFor(t).price.value;
      if (p.status !== "PAID") return { error: { code: "92005", message: "Payment status must be PAID" } };
      if (p.id !== t.payment.id) return { error: { code: "92005", message: `Unknown payment id ${p.id}` } };
      if (String(p.params?.amount) !== total) return { error: { code: "92005", message: `Paid amount ${p.params?.amount} != quote ${total}` } };
      if (!p.params?.transaction_id) return { error: { code: "92005", message: "Missing payment params.transaction_id" } };

      const orderId = crypto.randomBytes(4).toString("hex");
      const validTo = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
      const ts = new Date().toISOString();
      t.order = {
        id: orderId,
        status: "ACTIVE",
        items: orderItems(t),
        provider: provider(),
        fulfillments: [tripFulfillment(t.path!), ...ticketFulfillments(t.count!, { orderId, validTo, txn: t })],
        billing: t.billing,
        quote: quoteFor(t),
        payments: [{ ...t.payment, status: "PAID", params: { ...t.payment.params, ...p.params } }],
        cancellation_terms: cancellationTerms,
        created_at: ts,
        updated_at: ts,
      };
      ordersById.set(orderId, t.order);
      t.confirmCtx = ctx;
      return { message: { order: t.order } };
    },

    status(_ctx, msg) {
      const order = ordersById.get(msg.order_id ?? msg.ref_id);
      if (!order) return { error: { code: "92006", message: "Order not found" } };
      return { message: { order } };
    },
  };

  async function sendCallback(req: Body, result: Result) {
    const action = `on_${req.context.action}`;
    const body = JSON.stringify({
      context: { ...req.context, action, version: VERSION, bpp_id: bppId, bpp_uri: bppUri, timestamp: new Date().toISOString() },
      ...result,
    });
    const url = `${req.context.bap_uri}/${action}`;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: await signHeader(body, bppId, ukId, keys.privateKey) },
        body,
      });
      log(`-> ${action} ${url} (${res.status})`);
    } catch (err) {
      log(`-> ${action} ${url} FAILED: ${(err as Error).message}`);
    }
  }

  function process(body: Body) {
    const action = body.context.action;
    if (opts.dropActions.has(action)) return log(`   (dropping ${action} callback: MOCK_DROP_ACTIONS)`);
    setTimeout(() => {
      const result = handlers[action](body.context, body.message ?? {});
      if (result.message || result.error) void sendCallback(body, result);
    }, opts.delayMs);
  }

  const router = Router();

  /**
   * Dev trigger: the operator pushes an update on its own (no request from the BAP), like
   * DMRC does when a QR is scanned at the gate, the journey ends, or it cancels the order.
   *   POST /<seller>/dev/push/:transactionId?kind=claimed|completed|cancel[&charges=20]
   */
  router.post("/dev/push/:transactionId", async (req, res) => {
    const t = txns.get(String(req.params.transactionId));
    if (!t?.order || !t.confirmCtx) return void res.status(404).json({ error: "No confirmed order for this transaction_id" });
    const kind = String(req.query.kind ?? "claimed");
    const order = t.order;
    const setTicketStatus = (status: string) => {
      for (const f of order.fulfillments ?? [])
        for (const stop of f.stops ?? []) if (stop.authorization) stop.authorization.status = status;
    };

    let action: "status" | "cancel" = "status";
    if (kind === "claimed") {
      setTicketStatus("CLAIMED");
    } else if (kind === "completed") {
      setTicketStatus("CLAIMED");
      order.status = "COMPLETED";
    } else if (kind === "cancel") {
      action = "cancel";
      const charges = Math.max(0, Number(req.query.charges ?? 0) || 0);
      const paid = Number(order.quote?.price?.value ?? 0);
      const refund = Math.max(0, paid - charges);
      order.status = "CANCELLED";
      order.cancellation = { cancelled_by: "PROVIDER", reason: { descriptor: { code: "007" } } };
      order.quote = {
        price: { currency: "INR", value: String(charges) },
        breakup: [
          ...(order.quote?.breakup ?? []),
          { title: "REFUND", price: { currency: "INR", value: String(-refund) } },
          { title: "CANCELLATION_CHARGES", price: { currency: "INR", value: String(charges) } },
        ],
      };
    } else {
      return void res.status(400).json({ error: "kind must be claimed | completed | cancel" });
    }
    order.updated_at = new Date().toISOString();

    const pushCtx: Record<string, any> = { ...t.confirmCtx, action, message_id: crypto.randomUUID() };
    log(`   (dev) pushing unsolicited on_${action} (${kind}) txn=${pushCtx.transaction_id}`);
    await sendCallback({ context: pushCtx, message: {} }, { message: { order } });
    res.json({ pushed: `on_${action}`, kind, orderStatus: order.status });
  });

  router.post("/:action", async (req, res) => {
    const action = String(req.params.action);
    const body = req.body as Body;
    const ctx = body?.context ?? {};
    const nack = (status: number, code: string, message: string) =>
      res.status(status).json({ message: { ack: { status: "NACK" } }, error: { code, message } });

    if (!handlers[action] || ctx.action !== action || !ctx.transaction_id || !ctx.message_id || !ctx.bap_uri)
      return void nack(400, "10000", "Bad request: unknown action or incomplete context");
    if (ctx.domain !== "ONDC:TRV11") return void nack(400, "10000", `Unsupported domain ${ctx.domain}`);
    if (action !== "search" && ctx.bpp_id !== bppId) return void nack(400, "10000", `context.bpp_id must be ${bppId}`);

    const { signer, error } = await verifyFromRegistry(req);
    if (error) {
      log(`<- ${action} REJECTED: ${error}`);
      return void nack(401, "10001", `Invalid Signature: ${error}`);
    }
    if (signer!.subscriber_id !== ctx.bap_id) return void nack(401, "10001", "Signer is not context.bap_id");

    log(`<- ${action} txn=${ctx.transaction_id} (signature OK)`);
    res.json({ message: { ack: { status: "ACK" } } });
    process(body);
  });

  return {
    data,
    bppId,
    bppUri,
    router,
    acceptForwardedSearch(body: Body) {
      log(`<- search (via gateway) txn=${body.context.transaction_id}`);
      process(body);
    },
  };
}
