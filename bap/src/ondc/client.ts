import { config } from "../config.js";
import { addLog, fail, startWait, type Booking } from "../store.js";
import { buildContext, type OndcContext } from "./context.js";
import type { OndcAction } from "./enums.js";
import { signRequest } from "./signing.js";

/**
 * Send one signed Beckn request. The HTTP reply is only ACK/NACK; the real answer arrives later at
 * our callback endpoint (callbacks.ts), matched by transaction_id + message_id.
 *
 *   to = "gateway": city-level search, broadcast to every seller (no bpp in context)
 *   to = "seller":  everything after, sent straight to the chosen seller's bpp_uri
 */
export async function sendOndc(
  b: Booking,
  action: OndcAction,
  message: Record<string, unknown>,
  to: "gateway" | "seller",
): Promise<OndcContext | null> {
  const bpp = to === "seller" && b.seller ? { id: b.seller.bppId, uri: b.seller.bppUri } : undefined;
  if (to === "seller" && !bpp) {
    fail(b, `No seller chosen for ${action}`);
    return null;
  }
  const url = to === "gateway" ? config.gatewaySearchUrl : `${bpp!.uri}/${action}`;
  const context = buildContext(action, b.txnId, bpp);
  const rawBody = JSON.stringify({ context, message });
  const authorization = await signRequest(rawBody);

  addLog(b, { dir: "out", action, messageId: context.message_id, note: `-> ${url}`, body: { context, message }, headers: { Authorization: authorization } });
  startWait(b, `on_${action}`, context.message_id, config.callbackTimeoutMs);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: authorization },
      body: rawBody,
      signal: AbortSignal.timeout(10_000),
    });
    const ack = (await res.json().catch(() => null)) as { message?: { ack?: { status?: string } }; error?: { code?: string; message?: string } } | null;
    const status = ack?.message?.ack?.status;
    addLog(b, { dir: "in", action: `${action} (sync reply)`, note: status ?? `HTTP ${res.status}`, body: ack });

    if (status !== "ACK") {
      fail(b, `NACK for ${action}: ${ack?.error?.message ?? `HTTP ${res.status}`}`);
      return null;
    }
    return context;
  } catch (err) {
    fail(b, `Could not reach ${to} for ${action}: ${(err as Error).message}`);
    return null;
  }
}
