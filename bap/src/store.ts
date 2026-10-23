import type { Billing } from "./ondc/payloads.js";
import type { Offer, SellerNetwork, Station, Ticket } from "./ondc/parse.js";

// In-memory booking store, keyed by ONDC transaction_id. Real version: Postgres tables.

export type BookingState =
  | "NEW" //               city search sent
  | "STATIONS_LOADED" //   at least one seller sent its network (more may still arrive)
  | "OFFERED" //           chosen seller sent fare products for the route
  | "QUOTED" //            on_select: firm quote for N passengers
  | "INITIALIZED" //       on_init: payment terms
  | "PAYMENT_DONE" //      rider paid (fake gateway), confirm sent
  | "CONFIRMED" //         on_confirm: order + QR per passenger
  | "FAILED";

export interface LogEntry {
  at: string;
  dir: "out" | "in";
  action: string;
  messageId?: string;
  note?: string;
  signature?: "verified" | "failed" | "skipped";
  body?: unknown;
  headers?: Record<string, string>;
}

export interface Booking {
  txnId: string;
  state: BookingState;
  waitingFor: string | null;
  pendingMessageId: string | null;
  citySearchMessageId: string | null; // several sellers may answer this one search

  sellers: SellerNetwork[];
  seller?: { bppId: string; bppUri: string; providerId: string; name: string };
  route?: { from: Station; to: Station };
  offers: Offer[];
  trip: Station[];
  selection?: { itemId: string; count: number };
  quote?: { total: number; currency: string; breakup: { title: string; value: string }[]; ticketCount: number };
  billing?: Billing;
  payment?: {
    id: string;
    collectedBy: string;
    status: string;
    amount: number;
    gatewayRef?: string;
    tags: unknown[];
    settlement: { group: string; code: string; value: string }[];
  };
  order?: { id: string; status: string };
  tickets: Ticket[];
  error?: string;
  log: LogEntry[];
}

const bookings = new Map<string, Booking>();
const timers = new Map<string, NodeJS.Timeout>();

export function createBooking(txnId: string): Booking {
  const b: Booking = {
    txnId,
    state: "NEW",
    waitingFor: null,
    pendingMessageId: null,
    citySearchMessageId: null,
    sellers: [],
    offers: [],
    trip: [],
    tickets: [],
    log: [],
  };
  bookings.set(txnId, b);
  return b;
}

export const getBooking = (txnId: string) => bookings.get(txnId);

export function addLog(b: Booking, entry: Omit<LogEntry, "at">) {
  b.log.push({ at: new Date().toISOString(), ...entry });
}

export function fail(b: Booking, reason: string) {
  clearWait(b);
  b.state = "FAILED";
  b.error = reason;
  addLog(b, { dir: "in", action: "FAILED", note: reason });
}

/** Mark that we're waiting for `callback`; if it doesn't arrive in time, the booking fails. */
export function startWait(b: Booking, callback: string, messageId: string, timeoutMs: number) {
  clearWait(b);
  b.waitingFor = callback;
  b.pendingMessageId = messageId;
  timers.set(
    b.txnId,
    setTimeout(() => fail(b, `Timed out waiting for ${callback} after ${timeoutMs}ms`), timeoutMs),
  );
}

export function clearWait(b: Booking) {
  const t = timers.get(b.txnId);
  if (t) clearTimeout(t);
  timers.delete(b.txnId);
  b.waitingFor = null;
  b.pendingMessageId = null;
}
