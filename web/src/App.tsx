import { QRCodeSVG } from "qrcode.react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, type Booking, type Info, type LogEntry, type SellerNetwork, type Ticket } from "./api";

const STEPS = ["STATIONS_LOADED", "OFFERED", "QUOTED", "INITIALIZED", "CONFIRMED"] as const;
const STEP_LABELS = ["Network", "Fares", "Quote", "Payment terms", "Tickets"];

export function App() {
  const [booking, setBooking] = useState<Booking | null>(null);
  const [info, setInfo] = useState<Info | null>(null);
  const [uiError, setUiError] = useState<string | null>(null);
  const started = useRef(false);

  // Trigger a step on the BAP, then poll until the matching on_* callback has landed.
  const run = useCallback(async (step: () => Promise<Booking>) => {
    setUiError(null);
    try {
      let b = await step();
      setBooking(b);
      while (b.waitingFor) {
        await new Promise((r) => setTimeout(r, 400));
        b = await api.get(b.txnId);
        setBooking(b);
      }
      // Late sellers may still answer the city search; one extra refresh picks them up.
      if (b.state === "STATIONS_LOADED") setTimeout(() => api.get(b.txnId).then(setBooking).catch(() => {}), 1500);
    } catch (err) {
      setUiError((err as Error).message);
    }
  }, []);

  const startOver = useCallback(() => {
    setBooking(null);
    void run(api.start);
  }, [run]);

  useEffect(() => {
    if (started.current) return; // StrictMode runs effects twice in dev
    started.current = true;
    api.info().then(setInfo).catch(() => {});
    startOver();
  }, [startOver]);

  return (
    <div className="page">
      <header>
        <h1>Metro booking sandbox · V2</h1>
        <p className="muted">
          Our buyer app (BAP) on the ONDC {info?.domain ?? "TRV11"} v{info?.version ?? "2.0.1"} flow. Every request and
          callback is signed. Network: {info ? <span className="mono">{info.gateway.replace(/\/search$/, "")}</span> : "…"}. Not real tickets.
        </p>
        {info && !info.signatureCheck && <p className="error small">Signature checking is OFF (SIGNATURE_CHECK=off)</p>}
      </header>

      <div className="grid">
        <section className="card">
          {booking ? <Flow booking={booking} run={run} startOver={startOver} /> : <p className="muted">Starting…</p>}
          {uiError && <p className="error">{uiError}</p>}
        </section>

        <section className="card log-card">
          <h2>Protocol log</h2>
          <p className="muted small">
            → sent by us · ← received. Each request gets an instant ACK; the answer arrives later as a signed on_* callback.
            The badge shows whether the callback's signature verified against the sender's key in the registry.
          </p>
          {booking && (
            <p className="mono small">
              transaction_id: {booking.txnId}
              {booking.waitingFor && <span className="waiting"> · waiting for {booking.waitingFor}…</span>}
            </p>
          )}
          <Log entries={booking?.log ?? []} />
        </section>
      </div>
    </div>
  );
}

type Run = (s: () => Promise<Booking>) => Promise<void>;

function Flow({ booking: b, run, startOver }: { booking: Booking; run: Run; startOver: () => void }) {
  const busy = !!b.waitingFor;
  const reached = STEPS.indexOf(b.state as (typeof STEPS)[number]);

  if (b.state === "FAILED") {
    return (
      <div>
        <h2>Booking failed</h2>
        <p className="error">{b.error}</p>
        <button onClick={startOver}>Start over</button>
      </div>
    );
  }

  const beforePayment = !["INITIALIZED", "PAYMENT_DONE", "CONFIRMED"].includes(b.state);

  return (
    <div className="flow">
      <ol className="steps">
        {STEP_LABELS.map((label, i) => (
          <li key={label} className={i <= reached ? "done" : ""}>
            {label}
          </li>
        ))}
      </ol>

      {b.state === "NEW" && <p className="muted">Searching the network for metro sellers in Delhi…</p>}
      {b.sellers.length > 0 && beforePayment && <RouteStep b={b} busy={busy} run={run} />}
      {b.offers.length > 0 && (b.state === "OFFERED" || b.state === "QUOTED") && <FareStep b={b} busy={busy} run={run} />}
      {b.quote && b.state === "QUOTED" && <QuoteStep b={b} busy={busy} run={run} />}
      {b.payment && (b.state === "INITIALIZED" || b.state === "PAYMENT_DONE") && <PaymentStep b={b} busy={busy} run={run} />}
      {b.state === "CONFIRMED" && <Tickets b={b} busy={busy} run={run} startOver={startOver} />}
    </div>
  );
}

function RouteStep({ b, busy, run }: { b: Booking; busy: boolean; run: Run }) {
  const [bppId, setBppId] = useState(b.seller?.bppId ?? b.sellers[0].bppId);
  const [from, setFrom] = useState(b.route?.from.code ?? "");
  const [to, setTo] = useState(b.route?.to.code ?? "");
  const seller = b.sellers.find((s) => s.bppId === bppId) ?? b.sellers[0];

  const pickSeller = (id: string) => {
    setBppId(id);
    setFrom("");
    setTo("");
  };

  return (
    <fieldset disabled={busy}>
      <legend>1 · Network &amp; route</legend>
      {b.sellers.length > 1 && (
        <div className="sellers">
          {b.sellers.map((s) => (
            <label key={s.bppId} className={`chip ${s.bppId === bppId ? "on" : ""}`}>
              <input type="radio" name="seller" checked={s.bppId === bppId} onChange={() => pickSeller(s.bppId)} />
              {s.name}
            </label>
          ))}
        </div>
      )}
      <p className="muted small">
        {seller.name} · {seller.lines.map((l) => l.name).join(", ")} · <span className="mono">{seller.bppId}</span>
      </p>
      <div className="row">
        <StationSelect seller={seller} value={from} onChange={setFrom} placeholder="From…" />
        <StationSelect seller={seller} value={to} onChange={setTo} placeholder="To…" />
        <button disabled={!from || !to} onClick={() => run(() => api.search(b.txnId, seller.bppId, from, to))}>
          Find fares
        </button>
      </div>
    </fieldset>
  );
}

function StationSelect({ seller, value, onChange, placeholder }: { seller: SellerNetwork; value: string; onChange: (v: string) => void; placeholder: string }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">{placeholder}</option>
      {seller.lines.map((l) => (
        <optgroup key={l.routeId} label={l.name}>
          {l.stations.map((s) => (
            <option key={`${l.routeId}-${s.code}`} value={s.code}>
              {s.name}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}

function FareStep({ b, busy, run }: { b: Booking; busy: boolean; run: Run }) {
  const [itemId, setItemId] = useState(b.selection?.itemId ?? b.offers[0].itemId);
  const [count, setCount] = useState(b.selection?.count ?? 1);
  const offer = b.offers.find((o) => o.itemId === itemId) ?? b.offers[0];
  return (
    <fieldset disabled={busy}>
      <legend>2 · Ticket</legend>
      {b.route && (
        <p className="small">
          {b.route.from.name} → {b.route.to.name}
          <span className="muted"> · {Math.max(b.trip.length - 1, 0)} stops · {b.seller?.name}</span>
        </p>
      )}
      <div className="sellers">
        {b.offers.map((o) => (
          <label key={o.itemId} className={`chip ${o.itemId === itemId ? "on" : ""}`}>
            <input type="radio" name="offer" checked={o.itemId === itemId} onChange={() => setItemId(o.itemId)} />
            {o.name} · <strong>₹{o.unitPrice}</strong>
            {o.validity && <span className="muted small"> · valid {o.validity.replace(/^PT?/, "").toLowerCase()}</span>}
          </label>
        ))}
      </div>
      <div className="row">
        <label>
          Passengers{" "}
          <input type="number" min={offer.minCount} max={offer.maxCount} value={count} onChange={(e) => setCount(Number(e.target.value))} />
        </label>
        <button onClick={() => run(() => api.select(b.txnId, itemId, count))}>Get quote</button>
      </div>
    </fieldset>
  );
}

function QuoteStep({ b, busy, run }: { b: Booking; busy: boolean; run: Run }) {
  const [name, setName] = useState("Test Rider");
  const [phone, setPhone] = useState("+91-9999999999");
  const [email, setEmail] = useState("rider@example.com");
  const q = b.quote!;
  return (
    <fieldset disabled={busy}>
      <legend>3 · Quote</legend>
      <p>
        Total <strong>₹{q.total}</strong>
        <span className="muted small">
          {" "}
          · {q.ticketCount} ticket{q.ticketCount === 1 ? "" : "s"} (one QR per passenger)
          {q.breakup.map((x) => ` · ${x.title} ₹${x.value}`)}
        </span>
      </p>
      <div className="row">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" />
        <input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="Phone" />
        <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email" />
        <button onClick={() => run(() => api.init(b.txnId, name, phone, email))}>Continue to payment</button>
      </div>
    </fieldset>
  );
}

function PaymentStep({ b, busy, run }: { b: Booking; busy: boolean; run: Run }) {
  const p = b.payment!;
  return (
    <fieldset disabled={busy}>
      <legend>4 · Payment</legend>
      <p>
        Amount <strong>₹{p.amount}</strong> · collected by <strong>{p.collectedBy}</strong> · payment id{" "}
        <span className="mono">{p.id}</span>
      </p>
      {p.settlement.length > 0 && (
        <ul className="small muted terms">
          {p.settlement.map((s) => (
            <li key={`${s.group}-${s.code}`}>
              {s.group} → {s.code}: {s.value}
            </li>
          ))}
        </ul>
      )}
      {b.state === "INITIALIZED" ? (
        <button className="primary" onClick={() => run(() => api.pay(b.txnId))}>
          Pay ₹{p.amount} (fake gateway)
        </button>
      ) : (
        <p className="muted">Paid ({p.gatewayRef}). Waiting for the seller to issue tickets…</p>
      )}
    </fieldset>
  );
}

function Tickets({ b, busy, run, startOver }: { b: Booking; busy: boolean; run: Run; startOver: () => void }) {
  return (
    <div className="tickets-wrap">
      <h2>
        Your tickets <span className="muted small">· order {b.order?.id} · {b.order?.status}</span>
      </h2>
      {b.route && (
        <p className="small muted">
          {b.route.from.name} → {b.route.to.name} · {b.seller?.name}
        </p>
      )}
      <div className="tickets">
        {b.tickets.map((t, i) => (
          <TicketCard key={t.fulfillmentId} t={t} n={i + 1} />
        ))}
      </div>
      <div className="row center">
        <button disabled={busy} onClick={() => run(() => api.status(b.txnId))}>
          Refresh status
        </button>
        <button onClick={startOver}>Book another</button>
      </div>
    </div>
  );
}

function TicketCard({ t, n }: { t: Ticket; n: number }) {
  // Sellers may send the QR as a payload string, or as a ready-made base64 PNG image.
  const isPng = t.qrToken.startsWith("iVBOR");
  return (
    <div className="ticket">
      <div className="qr">
        {isPng ? <img src={`data:image/png;base64,${t.qrToken}`} width={160} height={160} alt={`QR ticket ${n}`} /> : <QRCodeSVG value={t.qrToken} size={160} />}
      </div>
      <p className="small">
        Passenger {n} · <span className="mono">{t.number ?? t.fulfillmentId}</span>
      </p>
      <p className="muted small">
        {t.status} · valid until {t.validTo ? new Date(t.validTo).toLocaleString() : "?"}
      </p>
    </div>
  );
}

function Log({ entries }: { entries: LogEntry[] }) {
  const [open, setOpen] = useState<number | null>(null);
  if (!entries.length) return <p className="muted small">Nothing yet.</p>;
  return (
    <ol className="log">
      {entries.map((e, i) => (
        <li key={i} className={e.dir}>
          <button className="log-row" onClick={() => setOpen(open === i ? null : i)} disabled={!e.body}>
            <span className="arrow">{e.dir === "out" ? "→" : "←"}</span>
            <span className="action">{e.action}</span>
            {e.signature && <span className={`sig ${e.signature}`}>{e.signature === "verified" ? "sig ✓" : e.signature === "failed" ? "sig ✗" : "sig –"}</span>}
            {e.dir === "out" && e.headers?.Authorization && <span className="sig verified">signed</span>}
            {e.note && <span className="note">{e.note}</span>}
            <span className="time">{new Date(e.at).toLocaleTimeString()}</span>
          </button>
          {open === i && e.body != null && <pre>{JSON.stringify(e.headers ? { headers: e.headers, ...(e.body as object) } : e.body, null, 2)}</pre>}
        </li>
      ))}
    </ol>
  );
}
