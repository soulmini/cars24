/**
 * End-to-end API tests.
 *
 * These run the real agent loop against the real tools and the real dataset,
 * with the mock LLM provider standing in for Gemini. That covers everything
 * except the model call itself, with no key and no network - so the suite is
 * fast, free and deterministic.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { config } from '../src/config.js';
import { MockProvider } from '../src/llm/mock.js';

let server;
let baseUrl;

before(async () => {
  const cfg = { ...config, nodeEnv: 'test' };
  const { app } = createApp({ cfg, provider: new MockProvider() });
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  baseUrl = 'http://127.0.0.1:' + server.address().port;
});

after(() => server?.close());

const get = async (path) => {
  const res = await fetch(baseUrl + path);
  return { status: res.status, body: await res.json() };
};

const ask = async (question, history) => {
  const res = await fetch(baseUrl + '/api/query', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ question, history }),
  });
  return { status: res.status, body: await res.json() };
};

describe('service endpoints', () => {
  test('GET / describes the service', async () => {
    const { status, body } = await get('/');
    assert.equal(status, 200);
    assert.equal(body.service, 'ai-operations-copilot');
    assert.ok(body.endpoints['POST /api/query']);
  });

  test('GET /api/health reports dataset and provider', async () => {
    const { status, body } = await get('/api/health');
    assert.equal(status, 200);
    assert.equal(body.status, 'ok');
    assert.equal(body.provider, 'mock:deterministic');
    assert.ok(body.dataset.orders > 0);
  });

  test('GET /api/tools lists the model-visible tools', async () => {
    const { body } = await get('/api/tools');
    assert.ok(body.count >= 7);
    const names = body.tools.map((t) => t.name);
    assert.ok(names.includes('get_order_summary'));
    assert.ok(names.includes('get_operational_summary'));
  });

  test('unknown routes return a structured 404', async () => {
    const { status, body } = await get('/api/nope');
    assert.equal(status, 404);
    assert.equal(body.error.code, 'NOT_FOUND');
  });
});

describe('POST /api/query - the three questions from the brief', () => {
  test('Q1: "What\'s the payment status for order #4521?"', async () => {
    const { status, body } = await ask("What's the payment status for order #4521?");
    assert.equal(status, 200);
    assert.ok(body.answer.length > 0);
    assert.match(body.answer, /ORD-4521/);
    assert.match(body.answer, /CAPTURED|captured/);

    // The answer must be grounded in an actual tool call.
    const toolSteps = body.trace.filter((t) => t.kind === 'tool');
    assert.ok(toolSteps.length >= 1);
    assert.ok(toolSteps.every((t) => t.ok));
    assert.equal(body.meta.stop_reason, 'answered');
  });

  test('Q2: "Customer says they\'ve paid for order #1289 but delivery isn\'t scheduled"', async () => {
    const { status, body } = await ask(
      "Customer says they've paid for order #1289 but delivery isn't scheduled - what's going on?",
    );
    assert.equal(status, 200);

    // The diagnosis, not just the raw status, must reach the answer.
    assert.match(body.answer, /ORD-1289/);
    assert.match(body.answer, /nothing scheduled|no delivery record/i);
    assert.match(body.answer, /CRITICAL/);
    assert.match(body.answer, /Next step:/);

    const toolStep = body.trace.find((t) => t.kind === 'tool');
    assert.ok(toolStep.finding_codes.includes('PAID_NO_DELIVERY_SCHEDULED'));
  });

  test('Q3: "Give me a full status summary for order #2231."', async () => {
    const { status, body } = await ask('Give me a full status summary for order #2231.');
    assert.equal(status, 200);
    assert.match(body.answer, /ORD-2231/);
    assert.match(body.answer, /Payment:/);
    assert.match(body.answer, /Delivery:/);

    const toolStep = body.trace.find((t) => t.kind === 'tool');
    assert.equal(toolStep.tool, 'get_order_summary');
    assert.ok(toolStep.finding_codes.includes('DELIVERY_OVERDUE'));
  });
});

describe('POST /api/query - routing and behaviour', () => {
  test('tracking questions route to the delivery tool', async () => {
    const { body } = await ask('What is the tracking number for order 2231?');
    const toolStep = body.trace.find((t) => t.kind === 'tool');
    assert.equal(toolStep.tool, 'get_delivery_details');
  });

  test('history questions route to the timeline tool', async () => {
    const { body } = await ask('What happened with order 4521? Show me the history.');
    const toolStep = body.trace.find((t) => t.kind === 'tool');
    assert.equal(toolStep.tool, 'get_order_timeline');
  });

  test('fleet-wide questions route to the operational summary', async () => {
    const { body } = await ask('Give me an operational overview of the business.');
    const toolStep = body.trace.find((t) => t.kind === 'tool');
    assert.equal(toolStep.tool, 'get_operational_summary');
    assert.match(body.answer, /paid with no delivery scheduled/);
  });

  test('an unknown order is reported honestly, not invented', async () => {
    const { status, body } = await ask('What is the status of order #9999?');
    assert.equal(status, 200);
    assert.match(body.answer, /could not|No order exists/i);

    const toolStep = body.trace.find((t) => t.kind === 'tool');
    assert.equal(toolStep.ok, false);
    assert.equal(toolStep.error_code, 'ORDER_NOT_FOUND');
  });

  test('every response carries an auditable trace and metadata', async () => {
    const { body } = await ask('Status of order 4521?');
    assert.ok(body.request_id);
    assert.ok(Array.isArray(body.trace));
    assert.ok(body.trace.length >= 2);
    assert.equal(body.meta.provider, 'mock:deterministic');
    assert.ok(typeof body.meta.duration_ms === 'number');
    for (const step of body.trace) {
      assert.ok(['model', 'tool'].includes(step.kind));
      assert.ok(typeof step.duration_ms === 'number');
    }
  });

  test('accepts prior conversation history', async () => {
    const { status, body } = await ask('And the payment status for order 4521?', [
      { role: 'user', content: 'Tell me about order 1289.' },
      { role: 'assistant', content: 'Order ORD-1289 is paid but not scheduled.' },
    ]);
    assert.equal(status, 200);
    assert.match(body.answer, /ORD-4521/);
  });
});

describe('POST /api/query - plain text output', () => {
  const askText = async (path, headers = {}) => {
    const res = await fetch(baseUrl + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ question: 'Give me a full status summary for order #2231.' }),
    });
    return { status: res.status, type: res.headers.get('content-type'), body: await res.text() };
  };

  test('?format=text returns the bare answer, not an envelope', async () => {
    const { status, type, body } = await askText('/api/query?format=text');
    assert.equal(status, 200);
    assert.match(type, /text\/plain/);
    assert.match(body, /ORD-2231/);
    assert.doesNotMatch(body, /"request_id"|"trace"|"meta"/,
      'plain text must not contain the JSON envelope');
  });

  test('Accept: text/plain returns the bare answer', async () => {
    const { status, type, body } = await askText('/api/query', { accept: 'text/plain' });
    assert.equal(status, 200);
    assert.match(type, /text\/plain/);
    assert.match(body, /ORD-2231/);
  });

  test('the text answer is identical to the JSON answer field', async () => {
    const text = await askText('/api/query?format=text');
    const json = await ask('Give me a full status summary for order #2231.');
    assert.equal(text.body, json.body.answer,
      'format must change the envelope, never the answer itself');
  });

  test('defaults to JSON when no preference is expressed', async () => {
    const { type } = await askText('/api/query');
    assert.match(type, /application\/json/);
  });

  test('a browser-style Accept header does not trigger text mode', async () => {
    // Browsers send */* - that is not an explicit text/plain preference.
    const { type } = await askText('/api/query', { accept: '*/*' });
    assert.match(type, /application\/json/);
  });

  test('?format=json overrides an Accept: text/plain header', async () => {
    const { type } = await askText('/api/query?format=json', { accept: 'text/plain' });
    assert.match(type, /application\/json/);
  });

  test('validation errors respect the text format too', async () => {
    const res = await fetch(baseUrl + '/api/query?format=text', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question: '' }),
    });
    assert.equal(res.status, 400);
    assert.match(res.headers.get('content-type'), /text\/plain/);
    const body = await res.text();
    assert.match(body, /non-empty/);
    assert.doesNotMatch(body, /\{/, 'a text client must not receive JSON on the error path');
  });
});

describe('POST /api/query - input validation', () => {
  test('rejects a missing question', async () => {
    const { status, body } = await ask(undefined);
    assert.equal(status, 400);
    assert.equal(body.error.code, 'INVALID_REQUEST');
  });

  test('rejects an empty question', async () => {
    const { status, body } = await ask('   ');
    assert.equal(status, 400);
    assert.equal(body.error.code, 'INVALID_REQUEST');
  });

  test('rejects an over-long question', async () => {
    const { status, body } = await ask('x'.repeat(2001));
    assert.equal(status, 400);
    assert.equal(body.error.code, 'QUESTION_TOO_LONG');
  });

  test('rejects a non-array history', async () => {
    const { status, body } = await ask('Status of 4521?', 'not-an-array');
    assert.equal(status, 400);
    assert.equal(body.error.code, 'INVALID_HISTORY');
  });
});

describe('direct REST endpoints (no LLM in the path)', () => {
  test('GET /api/orders/:id returns the summary with findings', async () => {
    const { status, body } = await get('/api/orders/1289');
    assert.equal(status, 200);
    assert.equal(body.order_id, 'ORD-1289');
    assert.equal(body.health, 'CRITICAL');
    assert.ok(body.findings.some((f) => f.code === 'PAID_NO_DELIVERY_SCHEDULED'));
  });

  test('GET /api/orders/:id returns 404 for an unknown order', async () => {
    const { status, body } = await get('/api/orders/999999');
    assert.equal(status, 404);
    assert.equal(body.error.code, 'ORDER_NOT_FOUND');
  });

  test('GET /api/orders filters by payment and delivery status', async () => {
    const { status, body } = await get('/api/orders?payment_status=PAID&delivery_status=NONE');
    assert.equal(status, 200);
    assert.ok(body.result_count > 0);
    assert.ok(body.orders.every((o) => o.delivery_status === 'NONE'));
  });

  test('GET /api/operations/summary returns risk counters', async () => {
    const { status, body } = await get('/api/operations/summary');
    assert.equal(status, 200);
    assert.ok(body.risk.paid_without_delivery_count > 0);
  });

  test('GET /api/orders/:id/timeline returns ordered events', async () => {
    const { status, body } = await get('/api/orders/4521/timeline');
    assert.equal(status, 200);
    assert.ok(body.timeline.length > 0);
  });
});
