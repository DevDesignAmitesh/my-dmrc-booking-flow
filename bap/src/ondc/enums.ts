// TRV11 2.0.1 enum values used by this buyer app (underscores, not hyphens).

export const PaymentStatus = { NOT_PAID: "NOT_PAID", PAID: "PAID" } as const;
export const PaymentType = { PRE_ORDER: "PRE_ORDER" } as const;
export const CollectedBy = { BAP: "BAP", BPP: "BPP" } as const;
export const VehicleCategory = { METRO: "METRO" } as const;
export const FulfillmentType = { ROUTE: "ROUTE", TRIP: "TRIP", TICKET: "TICKET" } as const;
export const StopType = { START: "START", END: "END", INTERMEDIATE_STOP: "INTERMEDIATE_STOP", TRANSIT_STOP: "TRANSIT_STOP" } as const;

export type OndcAction = "search" | "select" | "init" | "confirm" | "status";
