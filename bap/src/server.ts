import express, { type Request } from "express";
import { appRouter } from "./app.routes.js";
import { assertKeysConfigured, config } from "./config.js";
import { callbackRouter } from "./ondc/callbacks.js";
import { onSubscribe, siteVerification } from "./ondc/onboarding.js";

assertKeysConfigured();

const app = express();
// Keep the exact bytes: ONDC signatures cover the raw body, not re-serialised JSON.
app.use(express.json({ verify: (req, _res, buf) => void ((req as Request & { rawBody?: string }).rawBody = buf.toString("utf8")) }));

// Network-facing (must be on the public subscriber_id domain in real ONDC)
app.get("/ondc-site-verification.html", siteVerification);
app.post(`${config.callbackPath}/on_subscribe`.replace(/^\/\//, "/"), onSubscribe);
app.use(config.callbackPath, callbackRouter); // sellers' on_* callbacks

// App-facing: our web app
app.use("/metro", appRouter);

app.listen(config.port, () => {
  console.log(`[bap] ${config.bapId} on http://localhost:${config.port}  (${config.domain} v${config.coreVersion})`);
  console.log(`[bap]   callbacks ${config.bapUri}/on_*   gateway ${config.gatewaySearchUrl}`);
  console.log(`[bap]   registry  ${config.registryLookupUrl}   signature check ${config.signatureCheck ? "ON" : "OFF"}`);
});
