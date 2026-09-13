# AI Operations Copilot

A backend service that lets an operations team ask questions about orders in plain English and get answers they can act on immediately.

```
POST /api/query  { "question": "Customer says they've paid for order #1289 but delivery isn't scheduled - what's going on?" }
```

```
Order ORD-1289 - critical.

Order status: PROCESSING, placed 2024-05-10 via WEB.
Payment: CAPTURED via NET_BANKING, INR 82,598 captured.
Delivery: nothing scheduled - there is no delivery record for this order.
Open tickets: TKT-1289-1 (HIGH) "Paid but no delivery date".

Issues detected:
- [CRITICAL] Payment captured but no delivery has been scheduled - We captured
  INR 82,598 on 2024-05-10 (6 days ago) but there is no delivery record for this
  order. The order is sitting in PROCESSING.
  Next step: Check the fulfilment hold on this order, allocate inventory and book
  a courier slot today. If it cannot ship within 24h, proactively contact the
  customer with a revised date or offer a refund.
- [HIGH] Fulfilment is blocked at the warehouse - inventory allocation failed for
  one or more SKUs.
```

The design rationale is in [DESIGN.md](DESIGN.md). The short version: **the LLM routes and phrases, it does not diagnose.** Whether an order is in trouble is decided by deterministic rules over the actual records, so the answer above is a fact derived from rows, not a plausible-sounding sentence.

---

## Setup

Requires Node.js 20 or later. No database, no Docker, no external services.

```bash
npm install
npm run seed     # generates data/seed.json (already committed, so this is optional)
npm start
```

The service is now on `http://localhost:3000`.

### Running it with Gemini

It works without an API key — see the note below — but for real LLM answers:

```bash
cp .env.example .env
```

Then put your key in `.env`:

```
GEMINI_API_KEY=your-key-here
```

Get one free at [aistudio.google.com/apikey](https://aistudio.google.com/apikey). Restart, and the startup banner will read `provider: gemini:gemini-3.6-flash`.

> `.env` is gitignored. Never commit a key, and rotate any key that has been pasted into a chat window, shared screen or terminal recording.

### Running it without an API key

If `GEMINI_API_KEY` is not set, the service automatically falls back to a **deterministic mock provider** and says so at startup. Every endpoint works, every test passes, no network calls are made.

This exists so you can clone and evaluate this repo in sixty seconds without provisioning anything. The mock is not a language model — it routes on keywords and renders tool output through templates, so answers are correct but stilted. The `meta.provider` field in every response tells you which one produced the answer.

---

## Try it

```bash
npm run demo
```

Runs the three questions from the problem statement plus four harder ones in-process, printing each answer with the tools it called and the findings it detected. This is the fastest way to see the system work, and it also verifies a real Gemini key end to end if you have set one.

Or use curl. Add `?format=text` and you get the answer as plain prose, nothing else:

```bash
curl -s 'localhost:3000/api/query?format=text' \
  -H 'content-type: application/json' \
  -d '{"question":"What'\''s the payment status for order #4521?"}'
```

```
The payment status for order #4521 (ORD-4521) is PAID.

Payment summary:
- Status: PAID (State: CAPTURED)
- Amount paid: INR 1,20,946
- Method: CREDIT_CARD
- Payment attempts: 1 successful attempt (0 failures)

The payment is fully captured and the order is marked healthy with no outstanding issues.
```

Without `format=text` the same call returns the full JSON envelope — the answer plus the audit trail. Both are documented under [POST /api/query](#post-apiquery).

```bash
# no LLM in the path at all - raw diagnostics
curl -s localhost:3000/api/orders/1289 | jq '.health, .findings[].code'
```

---

## Tests

```bash
npm test
```

97 tests, no network, no API key, deterministic. They cover the diagnostic rules, the tool layer against the real seeded dataset, the agent loop's guardrails, the Gemini message mapping and the full HTTP surface end to end.

```
tests/diagnostics.test.js   rule correctness and severity escalation
tests/tools.test.js         tool behaviour against real seed data
tests/copilot.test.js       loop bounds: runaway models, tool errors, timeouts
tests/gemini.test.js        Gemini contents mapping and schema compatibility
tests/api.test.js           HTTP end to end, including the three brief questions
```

---

## API

Base URL `http://localhost:3000`. Responses are JSON by default; `POST /api/query` also serves plain text on request — see [Plain text](#plain-text) below.

### `POST /api/query`

The copilot. Ask anything about orders.

**Request**

| Field | Type | Required | Notes |
|---|---|---|---|
| `question` | string | yes | 1–2000 characters. |
| `history` | array | no | Prior turns as `{role, content}`, where role is `user` or `assistant`. |

```json
{
  "question": "Give me a full status summary for order #2231.",
  "history": []
}
```

**Response `200`**

```json
{
  "request_id": "5f8c...",
  "answer": "Order ORD-2231 - critical. ...",
  "meta": {
    "provider": "gemini:gemini-3.6-flash",
    "tool_rounds": 1,
    "stop_reason": "answered",
    "duration_ms": 1840,
    "usage": { "input_tokens": 2104, "output_tokens": 246 }
  },
  "trace": [
    { "step": 1, "kind": "model", "duration_ms": 890, "requested_tools": ["get_order_summary"], "finish_reason": "STOP" },
    { "step": 2, "kind": "tool", "tool": "get_order_summary", "args": { "order_id": "2231" },
      "ok": true, "error_code": null, "duration_ms": 2,
      "finding_codes": ["DELIVERY_OVERDUE", "OPEN_TICKET"] }
  ]
}
```

`trace` is the audit trail: every tool call, its arguments, its latency, and which diagnostic rules fired. When an ops agent disputes an answer, this shows exactly which records produced it. Set `EXPOSE_TRACE=false` to omit it.

`stop_reason` is one of `answered`, `max_tool_rounds` or `timeout`.

**Plain text**

For a bare answer with no envelope, ask for text — either with `?format=text` or an `Accept: text/plain` header. The query parameter wins if both are present.

```bash
curl -s 'localhost:3000/api/query?format=text' \
  -H 'content-type: application/json' \
  -d '{"question":"Give me a full status summary for order #2231."}'
```

```
Order ORD-2231 is in critical health because delivery is 20 days overdue due to a
courier vehicle breakdown.

Key Details:
- Customer: Pooja Joshi (CUST-00040), Kolkata
- Order Status: SHIPPED (1 x Robotic Vacuum Cleaner)
- Payment: PAID (INR 34,718 via WALLET)
- Delivery: DELAYED via BlueDart (AWB 831147267413) at Delhi hub, promised 2024-04-27
- Open Ticket: TKT-2231-1 ("Where is my order?", assigned to ops.team1)

Recommended Actions:
- Raise a courier escalation with AWB 831147267413 and give the customer a firm revised ETA.
- Follow up with ops.team1 on ticket TKT-2231-1.
```

The text is byte-identical to the JSON `answer` field — the format changes the envelope, never the answer. Errors respect the format too, so a text client gets a plain sentence rather than JSON on a 400 or 502. The trace is still computed and logged server-side; it is simply omitted from the response.

JSON is the default: a bare `Accept: */*` (what browsers and `fetch` send) does not trigger text mode.

**Errors**

| Status | Code | Cause |
|---|---|---|
| 400 | `INVALID_REQUEST` | Missing or empty `question`. |
| 400 | `QUESTION_TOO_LONG` | Over 2000 characters. |
| 400 | `INVALID_HISTORY` | `history` is not an array. |
| 429 | `RATE_LIMITED` | Over 60 requests/minute. `Retry-After` header is set. |
| 502 | `LLM_UNAVAILABLE` | The model could not be reached after retries. |

### Direct data endpoints (no LLM)

These call the same tools the model uses, without a model in the path. An ops dashboard should not pay for an LLM round trip to render an order page.

| Endpoint | Returns |
|---|---|
| `GET /api/orders/:id` | Full summary with `health` and `findings`. |
| `GET /api/orders/:id/payments` | Every payment attempt, with failure codes and gateway ids. |
| `GET /api/orders/:id/delivery` | Courier, AWB, promised date, attempts, overdue days. |
| `GET /api/orders/:id/timeline` | Chronological event log. |
| `GET /api/orders` | Filtered search. Query: `status`, `payment_status`, `delivery_status`, `customer_id`, `limit`. |
| `GET /api/operations/summary` | Fleet-wide counts and value at risk. |

`:id` accepts any form: `4521`, `#4521`, `ORD-4521`.

```bash
# every order that is paid with nothing scheduled - the money-at-risk query
curl -s 'localhost:3000/api/orders?payment_status=PAID&delivery_status=NONE' | jq
```

### Service endpoints

| Endpoint | Returns |
|---|---|
| `GET /` | Service description and endpoint index. |
| `GET /api/health` | Provider in use, dataset counts, uptime. |
| `GET /api/tools` | The tools exposed to the model. |

---

## The tools

The model cannot see the dataset. It can only call these seven read-only functions, and every fact in an answer comes from one of them.

| Tool | Purpose |
|---|---|
| `get_order_summary` | **Primary.** Order, payment, delivery, tickets, health verdict and diagnostics in one call. |
| `get_payment_details` | Full attempt history: retries, failure codes, gateway transaction ids, refunds. |
| `get_delivery_details` | Courier, tracking, promised date, attempt history, overdue calculation. |
| `get_order_timeline` | Chronological event log. |
| `search_orders` | Filtered search when there is no specific order id. |
| `find_customer` | Resolve a name or email to a customer id. |
| `get_operational_summary` | Fleet-wide health and value at risk. |

All seven are read-only, so a hallucinated call is at worst a wasted round trip and never a wrong write.

---

## Seed data

`npm run seed` regenerates `data/seed.json`: 120 orders, 60 customers, 123 payments, 90 deliveries, 41 tickets and 430 events.

It is **deterministic** — a seeded PRNG, not `Math.random()`, so re-running produces byte-identical output and the tests can assert against specific order ids.

Orders are generated across twelve deliberate operational scenarios rather than a uniform blob of happy paths: payments that failed and were retried, deliveries past their promised date, attempts exhausted into RTO, partial refunds for damaged goods, COD still uncollected, and orders paid with nothing scheduled. Three orders are pinned so the examples in the problem statement always resolve:

| Order | Scenario |
|---|---|
| `ORD-4521` | Delivered cleanly. Healthy — the copilot should say so and invent no concerns. |
| `ORD-1289` | Paid, warehouse hold, no delivery record, HIGH ticket open. |
| `ORD-2231` | Paid and dispatched, delivery delayed past the promised date. |

---

## Configuration

Every value has a working default; `.env` is optional.

| Variable | Default | Purpose |
|---|---|---|
| `LLM_PROVIDER` | `gemini` | `gemini` or `mock`. |
| `GEMINI_API_KEY` | — | Falls back to `mock` when empty. |
| `GEMINI_MODEL` | `gemini-3.6-flash` | Flash is sufficient: tool routing and factual summaries. |
| `LLM_TEMPERATURE` | `0.2` | Low — this is reporting, not writing. |
| `PORT` | `3000` | |
| `AGENT_MAX_TOOL_ROUNDS` | `5` | Ceiling on model round trips per question. |
| `AGENT_TIMEOUT_MS` | `90000` | Wall-clock budget per question. |
| `EXPOSE_TRACE` | `true` | Include the audit trail in responses. |
| `RATE_LIMIT_MAX` | `60` | Requests per minute per IP. |

---

## Layout

```
src/
  server.js            entry point, banner, graceful shutdown
  app.js               wiring (separate from server.js so tests need no port)
  config.js            env resolution and provider fallback
  agent/
    copilot.js         the tool-calling loop
    prompt.js          the system prompt
  llm/
    provider.js        provider interface
    gemini.js          Gemini adapter, retries, message mapping
    mock.js            deterministic offline provider
  tools/index.js       the seven tools and their schemas
  lib/diagnostics.js   deterministic rules - the heart of the system
  data/repository.js   data access, indexed at load
  api/routes.js        HTTP surface, validation, rate limiting
scripts/
  seed.js              deterministic data generator
  demo.js              runs the example questions
tests/                 97 tests
```
#   c a r s 2 4  
 #   c a r s 2 4  
 #   c a r s 2 4  
 #   c a r s 2 4  
 