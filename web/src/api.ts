// Mirrors bap/src/store.ts + bap/src/ondc/parse.ts (kept as a copy so the web app has no build-time dependency on the BAP).

export type BookingState =
  | "NEW"
  | "STATIONS_LOADED"
  | "OFFERED"
  | "QUOTED"
  | "INITIALIZED"
  | "PAYMENT_DONE"
  | "CONFIRMED"
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

export interface Station {
  code: string;
  name: string;
}

export interface SellerNetwork {
  bppId: string;
  bppUri: string;
  providerId: string;
  name: string;
  lines: { routeId: string; name: string; stations: Station[] }[];
}

export interface Offer {
  itemId: string;
  code: string;
  name: string;
  unitPrice: number;
  minCount: number;
  maxCount: number;
  validity?: string;
}

export interface Ticket {
  fulfillmentId: string;
  number?: string;
  qrToken: string;
  validTo?: string;
  status?: string;
}

export interface Booking {
  txnId: string;
  state: BookingState;
  waitingFor: string | null;
  sellers: SellerNetwork[];
  seller?: { bppId: string; bppUri: string; providerId: string; name: string };
  route?: { from: Station; to: Station };
  offers: Offer[];
  trip: Station[];
  selection?: { itemId: string; count: number };
  quote?: { total: number; currency: string; breakup: { title: string; value: string }[]; ticketCount: number };
  billing?: { name: string; phone: string; email?: string };
  payment?: {
    id: string;
    collectedBy: string;
    status: string;
    amount: number;
    gatewayRef?: string;
    settlement: { group: string; code: string; value: string }[];
  };
  order?: { id: string; status: string };
  tickets: Ticket[];
  error?: string;
  log: LogEntry[];
}

export interface Info {
  bapId: string;
  domain: string;
  version: string;
  gateway: string;
  registry: string;
  signatureCheck: boolean;
}

async function call<T = Booking>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/metro${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
  return json as T;
}

export const api = {
  info: () => call<Info>("GET", "/info"),
  start: () => call("POST", "/txn"),
  get: (id: string) => call("GET", `/txn/${id}`),
  search: (id: string, bppId: string, from: string, to: string) => call("POST", `/txn/${id}/search`, { bppId, from, to }),
  select: (id: string, itemId: string, count: number) => call("POST", `/txn/${id}/select`, { itemId, count }),
  init: (id: string, name: string, phone: string, email: string) => call("POST", `/txn/${id}/init`, { name, phone, email }),
  pay: (id: string) => call("POST", `/txn/${id}/pay`),
  status: (id: string) => call("POST", `/txn/${id}/status`),
};
