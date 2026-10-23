import { Router, type Request } from "express";
import { addLog, clearWait, fail, getBooking, type Booking } from "../store.js";
import { parseNetwork, parseOffers, parseOrder, parsePaymentTerms, parseQuote } from "./parse.js";
import { verifyIncoming } from "./signing.js";

/**
 * Where sellers call us back: POST <BAP_URI>/on_search, /on_select, ...
 * Order matters: verify signature -> ACK -> match to the request we sent -> apply.
 */

type Callback = {
  context: Record<string, any>;
  message?: Record<string, any>;
  error?: { code?: string; message?: string };
};

const apply: Record<string, (b: Booking, body: Callback, isCitySearch: boolean) => void> = {
  on_search(b, { context, message }, isCitySearch) {
    if (isCitySearch) {
      // One seller's network map. Others may answer the same search later; keep them all.
      const net = parseNetwork(context, message ?? {});
      if (!net || !net.lines.length) return;
      b.sellers = [...b.sellers.filter((s) => s.bppId !== net.bppId), net];
      if (b.state === "NEW") b.state = "STATIONS_LOADED";
      return;
    }
    const { offers, trip } = parseOffers(message ?? {});
    b.offers = offers;
    b.trip = trip;
    b.state = "OFFERED";
  },

  on_select(b, { message }) {
    b.quote = parseQuote(message ?? {});
    b.state = "QUOTED";
  },

  on_init(b, { message }) {
    const terms = parsePaymentTerms(message ?? {});
    b.quote = { ...b.quote!, ...parseQuote(message ?? {}) };
    b.payment = { ...terms, amount: b.quote.total };
    b.state = "INITIALIZED";
  },

  on_confirm(b, { message }) {
    const { orderId, status, tickets } = parseOrder(message ?? {});
    b.order = { id: orderId, status };
    b.tickets = tickets;
    b.state = "CONFIRMED";
  },

  on_status(b, { message }) {
    const { orderId, status, tickets } = parseOrder(message ?? {});
    b.order = { id: orderId, status };
    if (tickets.length) b.tickets = tickets;
  },
};

export const callbackRouter = Router();

callbackRouter.post("/:action", async (req, res) => {
  const action = String(req.params.action);
  const body = req.body as Callback;
  const ctx = body?.context ?? {};
  const nack = (status: number, code: string, message: string) =>
    res.status(status).json({ message: { ack: { status: "NACK" } }, error: { code, message } });

  const b = getBooking(ctx.transaction_id);
  if (!apply[action] || !b || ctx.action !== action) return void nack(404, "10000", "Unknown action or transaction");

  // 1. Who sent this? Signature must verify against the sender's key in the registry.
  const authorization = req.header("authorization");
  const sig = await verifyIncoming((req as Request & { rawBody?: string }).rawBody ?? "", authorization, ctx.bpp_id);
  if (sig.status === "failed") {
    addLog(b, { dir: "in", action, messageId: ctx.message_id, signature: "failed", note: `REJECTED: ${sig.reason}`, body });
    return void nack(401, "10001", `Invalid Signature: ${sig.reason}`);
  }

  // 2. ACK quickly: it only means "received".
  res.json({ message: { ack: { status: "ACK" } } });
  addLog(b, {
    dir: "in",
    action,
    messageId: ctx.message_id,
    signature: sig.status,
    note: sig.status === "verified" ? `from ${sig.signer}` : undefined,
    body,
    headers: authorization ? { Authorization: authorization } : undefined,
  });

  // 3. Match it to what we asked. City search may get answers from several sellers.
  const isAwaited = b.waitingFor === action && b.pendingMessageId === ctx.message_id;
  // (state NEW + awaited covers a seller answering before the gateway's ACK reached us)
  const isCitySearch = action === "on_search" && (ctx.message_id === b.citySearchMessageId || (b.state === "NEW" && isAwaited));
  if (!isCitySearch && !isAwaited) {
    addLog(b, { dir: "in", action, note: "ignored: not the callback we are waiting for (late or duplicate)" });
    return;
  }
  if (!isCitySearch && b.seller && ctx.bpp_id !== b.seller.bppId) {
    addLog(b, { dir: "in", action, note: `ignored: from ${ctx.bpp_id}, but we are transacting with ${b.seller.bppId}` });
    return;
  }

  if (body.error) {
    const reason = `${action} error ${body.error.code}: ${body.error.message}`;
    if (isCitySearch && !isAwaited) return void addLog(b, { dir: "in", action, note: `seller ${ctx.bpp_id}: ${reason}` });
    return void fail(b, reason);
  }

  if (isAwaited) clearWait(b);
  apply[action](b, body, isCitySearch);
});
