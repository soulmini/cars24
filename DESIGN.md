# Design

## The problem behind the problem

The brief asks for a service that answers questions like *"Customer says they've paid for order #1289 but delivery isn't scheduled — what's going on?"*

That third example is the one that determines the architecture. The first two ("what's the payment status", "give me a summary") are retrieval. The third is a **diagnosis**: it requires noticing that two subsystems disagree — money says paid, fulfilment says nothing scheduled — and explaining why.

The obvious implementation is to hand an LLM a pile of order JSON and let it reason. I did not build that, and the rest of this document is mostly about why.

The users are ops agents under time pressure who will read the answer out to a customer within the next minute. If the system says *"your order ships Thursday"* and no such date exists in any record, that is not a degraded answer — it is a false promise made to a real customer, in the company's voice. The cost of a confident wrong answer here is much higher than the cost of "I don't know."

So the central design constraint is: **an ops agent must be able to trust the answer without verifying it.** Everything below follows from that.

---

## The core decision: the LLM routes and phrases, it does not diagnose

The system splits into two halves with a hard boundary.

**Deterministic half** — [`src/lib/diagnostics.js`](src/lib/diagnostics.js). Whether an order is in trouble, how severe it is, and what to do about it are decided by explicit rules over the actual records. No model involved.

**Probabilistic half** — the LLM. It decides which tool answers the question, and it phrases the result in prose. Nothing else.

The model never sees the dataset. It cannot compute a diagnosis, and it is told in the system prompt that the `findings` array is ground truth it may not contradict.

Why this split:

**Correctness is testable.** A rule is a pure function; I can assert that a payment captured 6 days ago with no delivery record produces `PAID_NO_DELIVERY_SCHEDULED` at `CRITICAL`, and that a delivered order produces no findings at all. That test either passes or fails. You cannot write that assertion against a prompt — you can only sample it and hope. [`tests/diagnostics.test.js`](tests/diagnostics.test.js) has 22 such assertions.

**The dangerous failure mode disappears.** The way an LLM ruins this product is not by writing awkward prose, it is by inventing a delivery date, softening a critical problem into "there may be a slight delay", or manufacturing a cause the records do not support. Every one of those is a judgement about order state — and the model no longer makes judgements about order state.

**Severity thresholds are policy, not vibes.** "Stuck 3+ days is CRITICAL, less is HIGH" is a business rule that an ops lead should own, review, and change. It belongs in a file where it can be read and edited, not implied by a temperature setting.

**It is cheaper and faster.** One tool call, one model round trip, a small bounded payload. The model is doing routing and phrasing — work a fast, inexpensive model does well.

What I gave up: the model cannot spot a novel cross-signal pattern nobody encoded. That is a real loss, and I think it is the right trade. An unencoded pattern produces "no findings", which is a safe wrong answer. A hallucinated pattern produces a confident wrong answer delivered to a customer. Given a choice of failure modes, I want the quiet one.

### Rules as data

Each rule is a self-contained function of the order graph returning a structured finding:

```js
{
  code: 'PAID_NO_DELIVERY_SCHEDULED',   // stable, assertable, greppable in logs
  severity: 'CRITICAL',
  title: 'Payment captured but no delivery has been scheduled',
  detail: 'We captured INR 82,598 on 2024-05-10 (6 day(s) ago)...',
  evidence: { payment_id, captured_at, days_stuck, delivery_record: null },
  recommended_action: 'Check the fulfilment hold, allocate inventory and book...'
}
```

`evidence` is the audit trail — the specific fields the rule fired on. `recommended_action` matters more than it looks: an ops agent does not want to be told there is a problem, they want to be told what to do. Encoding the playbook next to the detection is what turns this from a status lookup into a copilot.

Adding an operational check is one function plus one test. Nothing else in the system changes, and the prompt is untouched.

Rules are wrapped individually in try/catch. A rule that throws produces a low-severity `RULE_ERROR` finding instead of taking down the whole answer — partial diagnosis beats a 500.

---

## Tool design

Seven read-only tools. Three decisions worth explaining.

**One primary tool, not six equal ones.** `get_order_summary` returns order, payment, delivery, tickets, health verdict and findings together. Early on I had separate `get_payment_status` and `get_delivery_status` tools, and the model would call the one the question named — ask about payment on order #1289 and it fetched payment, reported "captured", and stopped. Technically correct, and useless: the whole point of that order is that payment and delivery disagree. The fix was structural, not a prompt tweak. Make the default tool return the cross-signal view, so the diagnosis is present whichever way the question is phrased. The narrow tools remain for genuine specifics like transaction ids.

**Tools return digests, not rows.** `get_order_summary` returns formatted items and computed states, not the raw graph. This keeps token cost flat as the dataset grows, and it stops the model drowning in fields irrelevant to the question. The seed's internal `scenario` label is deliberately stripped — it would let the model shortcut the diagnosis, which is exactly the behaviour I want to prevent. [`tests/tools.test.js`](tests/tools.test.js) asserts it never leaks.

**Tool errors are results, not exceptions.** A bad order id returns `{ok: false, error: {code: 'ORDER_NOT_FOUND'}}`, which goes back to the model as data. The model then says "no such order exists" in its own words. The alternative — throwing — turns a recoverable mistake into a 500. This is what makes "what's the status of order #9999?" degrade gracefully.

Everything is read-only. A hallucinated tool call is a wasted round trip, never a wrong write. When mutating tools are added (issue refund, reschedule delivery) they will need confirmation flows and an approval boundary — see *What I would do next*.

---

## The agent loop

[`src/agent/copilot.js`](src/agent/copilot.js). Ask the model; it either answers or requests tools; run the tools; feed results back; repeat. Three properties matter more than sophistication.

**Bounded.** `maxToolRounds` (default 5) caps model round trips and a wall-clock budget caps latency. A confused model degrades into a slow honest answer, never an unbounded spend. [`tests/copilot.test.js`](tests/copilot.test.js) drives the loop with a provider that requests tools forever and asserts it stops.

**Observable.** Every step — model turn and tool call — records its arguments, latency, success and the finding codes it produced, returned as `trace`. This is not debug output. When an ops agent challenges an answer, the trace shows exactly which records produced it. Auditability is a product feature here, which is why it is on by default.

**Recoverable.** Tool errors return to the model as data. Parallel calls in one round run concurrently via `Promise.all`. If the loop ever ends without model text, a fallback produces a usable sentence rather than an empty string.

---

## Provider abstraction and the mock

The loop depends on an interface — `generate({system, messages, tools})` → `{toolCalls, text, usage}` — not on Gemini. Two implementations exist.

[`src/llm/gemini.js`](src/llm/gemini.js) handles everything vendor-specific: the `contents` mapping (tool results go back as a **user**-role turn with `functionResponse` parts, which is the non-obvious bit that silently breaks tool calling if you get it wrong), retries with exponential backoff and jitter on 429/5xx only, and error normalisation.

[`src/llm/mock.js`](src/llm/mock.js) is a deterministic offline provider: keyword intent routing plus templated rendering of tool output.

The mock is the decision I would most expect to be questioned, so: **a repo that only runs if the reviewer has an API key is a repo the reviewer cannot run.** With the fallback, `npm install && npm start` works immediately, and the full test suite runs with no key, no network and no flakiness — so a failing test means a real regression, not a rate limit. It is also the honest production answer to "what happens when Gemini is down": degraded templated answers from verified data beat a 502. Every response reports which provider produced it, so the degradation is never silent.

The fallback is automatic and loud — the startup banner states it plainly — because a silent fallback to a worse answer is exactly the kind of thing that erodes trust in the tool.

---

## Prompt design

[`src/agent/prompt.js`](src/agent/prompt.js), in its own module because it is a real artefact that gets revised like code.

Because the model does not diagnose, the prompt is mostly about constraining it to narrate verified output:

- Every fact must come from a tool result in this conversation.
- The `findings` array is authoritative — lead with the most severe, carry its `recommended_action`, never soften or contradict it.
- Empty findings means healthy: say so, invent no concerns. (Models love to hedge. An ops agent reading "there may be an issue" about a cleanly delivered order wastes five minutes proving there isn't.)
- Exact values only. Never estimate a money amount, never guess a date or tracking number.
- Say plainly when the tools do not have the answer. *"There is no delivery record for this order"* is a good answer; a plausible invented date is a serious failure.

Format rules — lead with the answer, then facts, then the action, three to eight lines, no headers or sign-offs — exist because the reader is mid-call with a customer.

---

## Data layer

Seed data is JSON behind a repository interface ([`src/data/repository.js`](src/data/repository.js)), indexed into hash maps at load. Order lookup is the hot path — every tool call starts with one — so it is O(1), not a scan.

Tools call repository methods shaped like the SQL queries they would become (`findOrders({paymentStatus, deliveryStatus, ...})` is a parameterised WHERE clause). Swapping in Postgres means one new class; nothing in `src/tools` or `src/agent` changes.

**On the choice of JSON:** a real schema would be a stronger engineering signal, and I would use Postgres in production. JSON was chosen here to keep evaluation friction at zero — no Docker, no migrations, clone and run. The repository boundary is what preserves the option to change it cheaply.

`repo.now()` returns the dataset's frozen `generated_at` rather than `Date.now()`. Every relative calculation goes through it, so "6 days stuck" stays 6 days forever and the tests never rot.

### Seed generation

[`scripts/seed.js`](scripts/seed.js) is deterministic — a seeded mulberry32 PRNG, so re-running produces byte-identical output and tests can assert against specific ids.

Data is generated across twelve **scenarios** rather than randomised fields, because random fields produce internally inconsistent orders — delivered but unpaid, refunded but in transit — and an ops copilot's entire job is reasoning about consistency between payment and fulfilment. Each scenario builds a coherent graph: order, payment attempts, delivery, tickets and a merged event timeline that all agree with each other. The mix deliberately includes failed-then-retried payments, deliveries past their promised date, attempts exhausted into RTO, partial refunds for damage, and COD uncollected. Three orders are pinned to the ids in the problem statement.

---

## API surface

`POST /api/query` is the copilot. Alongside it are direct REST endpoints that call the same tools with no model in the path.

Those exist because **not every question needs an LLM.** An ops dashboard rendering an order page should not pay for a model round trip to display a status. `GET /api/orders/1289` returns the same diagnostics, deterministically, in about a millisecond. It also makes the tool layer independently debuggable — when an answer looks wrong, hitting the REST endpoint tells you immediately whether the problem is in the data, the rules, or the model.

`POST /api/query` serves two audiences from one endpoint via content negotiation. A dashboard wants the JSON envelope — the answer plus the trace that makes it auditable. A human at a terminal wants the answer and nothing else, and gets it with `?format=text` or `Accept: text/plain`. Making the envelope the default and text opt-in keeps auditability the norm rather than something a caller has to remember to ask for, which is the behaviour the rest of this design argues for. The text is byte-identical to the JSON `answer` field: format changes the envelope, never the answer. The error paths honour the same negotiation, because a text client receiving JSON on a 502 is exactly the kind of inconsistency that breaks a shell pipeline.

Validation rejects bad input before it reaches the model. Rate limiting is a simple in-process fixed window with a sweep to bound memory — honest about being single-instance, and the right amount of machinery at this scale. Express 5 forwards async rejections to the error handler, so an LLM outage becomes a structured 502 rather than a hung socket.

---

## Testing

97 tests, no network, no key, deterministic.

The distribution reflects where the risk is. The heaviest coverage is on diagnostic rules, because that is where a bug produces a wrong answer an ops agent acts on. Rules are tested for both firing and **not** firing — `PAID_NO_DELIVERY_SCHEDULED` must not fire on cancelled or refunded orders, `SHIPPED_WITHOUT_PAYMENT` must not fire on COD, where shipping before payment is the whole point. False positives in an ops tool are as corrosive as misses: a copilot that cries wolf gets ignored, and then it is worth nothing.

The loop is tested against deliberately misbehaving providers — one that loops forever, one that returns nothing, one that throws — because its real job is staying bounded and honest when the model does not cooperate.

The Gemini adapter's message mapping is tested as a pure function, since it is the part most likely to be silently wrong and needs no network to verify.

The API tests run the three questions from the brief end to end and assert not just that an answer comes back, but that the trace shows the right tool was called and the right finding fired. An answer that happens to read correctly without grounding is a test failure.

**What is not tested automatically:** live Gemini output. The suite deliberately never calls the API, so the adapter's translation logic and schema compatibility are covered but the HTTP call is not. The live path *was* verified manually against `gemini-3.6-flash` during development, and doing so caught a real bug the offline tests could not — see below. `npm run demo` exercises it in one command.

---

## Trade-offs I would revisit

**Rules over model reasoning.** Covered above. Deliberate, and the thing I would defend hardest.

**JSON over a real schema.** Zero-setup evaluation bought at the cost of a weaker data-engineering signal. The repository boundary keeps it cheap to change.

**In-process rate limiting.** Single-instance only. Redis the moment there is more than one replica.

**No streaming.** Answers are short and one tool round is typical, so latency is acceptable and the code stays simple. If answers grew longer, streaming would matter for perceived speed.

**No caching.** Every question hits the model. Identical questions about unchanged orders are common in ops work, so a short TTL cache keyed on question plus order state would cut both cost and latency. Not built because it is premature at this scale.

**Conversation history is client-supplied.** No server-side session store. Simple and stateless, but it means the client owns continuity.

---

## What I would do next

1. **A real evaluation suite.** The correctness of the rules is tested; the quality of the *phrasing* is not. I would build a fixture set of question/order pairs with assertions on what must appear in the answer (the order id, the finding, the recommended action) and what must never (an invented date, a softened critical). Run it against real Gemini in CI. This is the single biggest gap.
2. **Postgres behind the existing repository interface**, with the query patterns the tools already imply.
3. **Write actions** — issue a refund, reschedule a delivery, escalate to a courier — behind an explicit confirmation step. The moment the copilot can act rather than report, the whole safety design changes: it needs an approval boundary, an idempotency key per action, and a permanent audit log of who approved what. Read-only was the right place to stop for this exercise.
4. **Feed the trace into observability.** The finding codes and stop reasons in the trace are already the right shape for metrics: how often each rule fires, how often answers hit the round ceiling, which tools dominate latency.
5. **Proactive alerting.** The diagnostic rules do not need a question to run. Sweeping all open orders nightly and pushing `CRITICAL` findings to the ops queue turns this from a tool you consult into one that tells you — which is where most of the operational value actually is.
