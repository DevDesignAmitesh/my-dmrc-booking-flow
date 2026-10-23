import crypto from "node:crypto";
import { config } from "../config.js";
import type { OndcAction } from "./enums.js";

export interface OndcContext {
  location: { country: { code: string }; city: { code: string } };
  domain: string;
  timestamp: string;
  bap_id: string;
  bap_uri: string;
  bpp_id?: string;
  bpp_uri?: string;
  transaction_id: string; // same for the whole journey search -> confirm -> status
  message_id: string; // new per request; the matching on_* callback echoes it back
  version: string;
  action: OndcAction;
  ttl: string; // how long the seller has to answer
}

export function buildContext(action: OndcAction, transactionId: string, bpp?: { id: string; uri: string }): OndcContext {
  return {
    location: { country: { code: config.country }, city: { code: config.cityCode } },
    domain: config.domain,
    timestamp: new Date().toISOString(),
    bap_id: config.bapId,
    bap_uri: config.bapUri,
    ...(bpp ? { bpp_id: bpp.id, bpp_uri: bpp.uri } : {}),
    transaction_id: transactionId,
    message_id: crypto.randomUUID(),
    version: config.coreVersion,
    action,
    ttl: `PT${Math.round(config.callbackTimeoutMs / 1000)}S`,
  };
}
