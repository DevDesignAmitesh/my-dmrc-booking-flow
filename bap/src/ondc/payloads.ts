import { config } from "../config.js";
import { CollectedBy, PaymentStatus, PaymentType, StopType, VehicleCategory } from "./enums.js";

/**
 * `message` builders for each TRV11 2.0.1 request, shaped like the official examples in
 * ONDC-Official/mobility-specification @ release-TRV11-2.0.1 (api/components/examples/metro/*).
 */

const tag = (code: string, list: [string, string][]) => ({
  descriptor: { code },
  display: false,
  list: list.map(([c, value]) => ({ descriptor: { code: c }, value })),
});

const bffTag = () => tag("BUYER_FINDER_FEES", [["BUYER_FINDER_FEES_PERCENTAGE", config.buyerFinderFeePercent]]);

/** Our payment proposal: we (the BAP) collect from the rider, and these are our terms. */
const searchPayment = () => ({
  collected_by: CollectedBy.BAP,
  tags: [bffTag(), tag("SETTLEMENT_TERMS", [["DELAY_INTEREST", "2.5"], ["STATIC_TERMS", config.staticTermsUrl]])],
});

/** search #1 (to the gateway): "which metro networks serve this city?" -> stations per line */
export const buildSearchByCity = () => ({
  intent: { fulfillment: { vehicle: { category: VehicleCategory.METRO } }, payment: searchPayment() },
});

/** search #2 (direct to the chosen seller): "fare products from START to END" */
export const buildSearchByStations = (from: string, to: string) => ({
  intent: {
    fulfillment: {
      stops: [
        { type: StopType.START, location: { descriptor: { code: from } } },
        { type: StopType.END, location: { descriptor: { code: to } } },
      ],
      vehicle: { category: VehicleCategory.METRO },
    },
    payment: searchPayment(),
  },
});

export const buildSelect = (providerId: string, itemId: string, count: number) => ({
  order: { items: [{ id: itemId, quantity: { selected: { count } } }], provider: { id: providerId } },
});

export interface Billing {
  name: string;
  phone: string;
  email?: string;
}

export const buildInit = (providerId: string, itemId: string, count: number, billing: Billing, total: number) => ({
  order: {
    items: [{ id: itemId, quantity: { selected: { count } } }],
    provider: { id: providerId },
    billing,
    payments: [
      {
        collected_by: CollectedBy.BAP,
        status: PaymentStatus.NOT_PAID,
        type: PaymentType.PRE_ORDER,
        tags: [
          bffTag(),
          tag("SETTLEMENT_TERMS", [
            // What we'd settle to the seller after keeping our buyer finder fee
            ["SETTLEMENT_AMOUNT", (total * (1 - Number(config.buyerFinderFeePercent) / 100)).toFixed(2)],
            ["SETTLEMENT_TYPE", "NEFT"],
            ["DELAY_INTEREST", "2.5"],
            ["STATIC_TERMS", config.staticTermsUrl],
            ["MANDATORY_ARBITRATION", "TRUE"],
            ["COURT_JURISDICTION", "New Delhi"],
          ]),
        ],
      },
    ],
  },
});

export interface ConfirmPayment {
  id: string; // payment id from on_init
  amount: number;
  gatewayTransactionId: string; // our payment gateway's reference
  tags: unknown[]; // settlement tags agreed in on_init, echoed back
}

export const buildConfirm = (providerId: string, itemId: string, count: number, billing: Billing, p: ConfirmPayment) => ({
  order: {
    items: [{ id: itemId, quantity: { selected: { count } } }],
    provider: { id: providerId },
    billing,
    payments: [
      {
        id: p.id,
        collected_by: CollectedBy.BAP,
        status: PaymentStatus.PAID,
        type: PaymentType.PRE_ORDER,
        params: { transaction_id: p.gatewayTransactionId, currency: "INR", amount: String(p.amount) },
        tags: p.tags,
      },
    ],
  },
});

export const buildStatus = (orderId: string) => ({ order_id: orderId });
