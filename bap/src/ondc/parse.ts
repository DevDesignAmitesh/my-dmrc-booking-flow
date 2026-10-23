import { FulfillmentType, StopType } from "./enums.js";

/** Turn TRV11 on_* messages into the small shapes our app needs. Lenient: sellers vary. */

export interface Station {
  code: string;
  name: string;
}
export interface Line {
  routeId: string;
  name: string;
  stations: Station[];
}
export interface SellerNetwork {
  bppId: string;
  bppUri: string;
  providerId: string;
  name: string;
  lines: Line[];
}
export interface Offer {
  itemId: string;
  code: string; // SJT / RJT / ...
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

type Obj = Record<string, any>;
const tagValue = (tags: Obj[] | undefined, group: string, code: string) =>
  tags?.find((t) => t.descriptor?.code === group)?.list?.find((l: Obj) => l.descriptor?.code === code)?.value;

const station = (s: Obj): Station => ({
  code: s.location?.descriptor?.code ?? s.location?.descriptor?.name,
  name: s.location?.descriptor?.name ?? s.location?.descriptor?.code,
});

/** on_search (by city): one seller's network map, from ROUTE fulfillments. */
export function parseNetwork(ctx: Obj, message: Obj): SellerNetwork | null {
  const p = message?.catalog?.providers?.[0];
  if (!p) return null;
  const lines: Line[] = (p.fulfillments ?? [])
    .filter((f: Obj) => f.type === FulfillmentType.ROUTE)
    .map((f: Obj) => ({
      routeId: tagValue(f.tags, "ROUTE_INFO", "ROUTE_ID") ?? f.id,
      name: tagValue(f.tags, "ROUTE_INFO", "ROUTE_NAME") ?? f.id,
      stations: (f.stops ?? []).map(station).filter((s: Station) => s.code),
    }));
  return {
    bppId: ctx.bpp_id,
    bppUri: ctx.bpp_uri,
    providerId: p.id,
    name: p.descriptor?.name ?? message.catalog?.descriptor?.name ?? ctx.bpp_id,
    lines,
  };
}

/** on_search (by stations): fare products + the trip's stops. */
export function parseOffers(message: Obj): { offers: Offer[]; trip: Station[] } {
  const p = message?.catalog?.providers?.[0] ?? {};
  const offers = (p.items ?? []).map((i: Obj) => ({
    itemId: i.id,
    code: i.descriptor?.code ?? i.id,
    name: i.descriptor?.name ?? i.id,
    unitPrice: Number(i.price?.value),
    minCount: Number(i.quantity?.minimum?.count ?? 1),
    maxCount: Number(i.quantity?.maximum?.count ?? 1),
    validity: i.time?.duration,
  }));
  const trip = (p.fulfillments ?? []).find((f: Obj) => f.type === FulfillmentType.TRIP);
  return { offers, trip: (trip?.stops ?? []).map(station) };
}

export function parseQuote(message: Obj) {
  const order = message?.order ?? {};
  const q = order.quote ?? {};
  return {
    total: Number(q.price?.value),
    currency: q.price?.currency ?? "INR",
    breakup: (q.breakup ?? []).map((b: Obj) => ({ title: b.title, value: b.price?.value })),
    ticketCount: (order.fulfillments ?? []).filter((f: Obj) => f.type === FulfillmentType.TICKET).length,
  };
}

export function parsePaymentTerms(message: Obj) {
  const p = message?.order?.payments?.[0] ?? {};
  const settlement = (p.tags ?? []).flatMap((t: Obj) =>
    (t.list ?? []).map((l: Obj) => ({ group: t.descriptor?.code, code: l.descriptor?.code, value: l.value })),
  );
  return {
    id: p.id as string,
    collectedBy: p.collected_by as string,
    status: p.status as string,
    type: p.type as string,
    bank: p.params as Obj | undefined,
    tags: (p.tags ?? []) as unknown[],
    settlement,
  };
}

/** on_confirm / on_status: order + one QR per passenger (TICKET fulfillments). */
export function parseOrder(message: Obj): { orderId: string; status: string; tickets: Ticket[] } {
  const order = message?.order ?? {};
  const tickets: Ticket[] = (order.fulfillments ?? [])
    .filter((f: Obj) => f.type === FulfillmentType.TICKET)
    .map((f: Obj) => {
      const auth = (f.stops ?? []).find((s: Obj) => s.type === StopType.START)?.authorization ?? {};
      return {
        fulfillmentId: f.id,
        number: tagValue(f.tags, "TICKET_INFO", "NUMBER"),
        qrToken: auth.token,
        validTo: auth.valid_to,
        status: auth.status,
      };
    })
    .filter((t: Ticket) => t.qrToken);
  return { orderId: order.id, status: order.status, tickets };
}
