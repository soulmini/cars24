/**
 * Tool layer tests, run against the real seeded dataset.
 *
 * These assert against the pinned order ids from the problem statement, which
 * is why the seed generator is deterministic.
 */
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { JsonRepository, normalizeOrderId } from '../src/data/repository.js';
import { createToolRegistry } from '../src/tools/index.js';

let repo;
let tools;

before(() => {
  repo = JsonRepository.fromFile();
  tools = createToolRegistry(repo);
});

describe('normalizeOrderId', () => {
  test('accepts every form an ops agent might type', () => {
    for (const input of ['4521', '#4521', 'ORD-4521', 'ord-4521', 'order 4521', 'Order #4521', '  4521  ']) {
      assert.equal(normalizeOrderId(input), 'ORD-4521', 'failed for: ' + input);
    }
  });

  test('rejects input with no order number', () => {
    assert.equal(normalizeOrderId('hello'), null);
    assert.equal(normalizeOrderId(''), null);
    assert.equal(normalizeOrderId(null), null);
  });
});

describe('get_order_summary', () => {
  test('answers the payment-status question for the pinned healthy order', async () => {
    const res = await tools.execute('get_order_summary', { order_id: '#4521' });
    assert.equal(res.ok, true);
    assert.equal(res.data.order_id, 'ORD-4521');
    assert.equal(res.data.payment.state, 'CAPTURED');
    assert.equal(res.data.payment.captured, true);
    assert.equal(res.data.health, 'HEALTHY');
    assert.deepEqual(res.data.findings, []);
  });

  test('detects the paid-but-not-scheduled case on order 1289', async () => {
    const res = await tools.execute('get_order_summary', { order_id: '1289' });
    assert.equal(res.ok, true);
    assert.equal(res.data.delivery_scheduled, false);
    assert.equal(res.data.delivery, null);
    assert.equal(res.data.payment.captured, true);

    const finding = res.data.findings.find((f) => f.code === 'PAID_NO_DELIVERY_SCHEDULED');
    assert.ok(finding, 'expected PAID_NO_DELIVERY_SCHEDULED');
    assert.equal(finding.severity, 'CRITICAL');
    assert.ok(finding.evidence.days_stuck > 0);
    assert.ok(finding.recommended_action.length > 20);
    assert.equal(res.data.health, 'CRITICAL');
  });

  test('explains the blockage with a warehouse-hold finding', async () => {
    const res = await tools.execute('get_order_summary', { order_id: '1289' });
    assert.ok(res.data.findings.some((f) => f.code === 'WAREHOUSE_HOLD'));
  });

  test('flags order 2231 as an overdue delivery', async () => {
    const res = await tools.execute('get_order_summary', { order_id: 'ORD-2231' });
    assert.equal(res.ok, true);
    assert.ok(res.data.delivery);
    const finding = res.data.findings.find((f) => f.code === 'DELIVERY_OVERDUE');
    assert.ok(finding, 'expected DELIVERY_OVERDUE');
    assert.ok(finding.evidence.days_overdue > 0);
  });

  test('returns a structured error for an unknown order', async () => {
    const res = await tools.execute('get_order_summary', { order_id: '999999' });
    assert.equal(res.ok, false);
    assert.equal(res.error.code, 'ORDER_NOT_FOUND');
  });

  test('returns a structured error for unparseable input', async () => {
    const res = await tools.execute('get_order_summary', { order_id: 'not an order' });
    assert.equal(res.ok, false);
    assert.equal(res.error.code, 'INVALID_ORDER_REFERENCE');
  });

  test('never leaks raw dataset internals into tool output', async () => {
    const res = await tools.execute('get_order_summary', { order_id: '4521' });
    assert.equal(res.data.order.scenario, undefined,
      'the scenario label is test metadata and must not reach the model');
  });
});

describe('get_payment_details', () => {
  test('returns the full attempt history', async () => {
    const res = await tools.execute('get_payment_details', { order_id: '4521' });
    assert.equal(res.ok, true);
    assert.ok(Array.isArray(res.data.attempts));
    assert.ok(res.data.attempts.length >= 1);
    assert.ok(res.data.attempts[0].payment_id.startsWith('PAY-'));
    assert.match(res.data.order_total_formatted, /^INR /);
  });
});

describe('get_delivery_details', () => {
  test('returns a null record with an explanation when nothing is scheduled', async () => {
    const res = await tools.execute('get_delivery_details', { order_id: '1289' });
    assert.equal(res.ok, true);
    assert.equal(res.data.delivery_record, null);
    assert.match(res.data.note, /No delivery has been scheduled/);
  });

  test('computes overdue days for a late delivery', async () => {
    const res = await tools.execute('get_delivery_details', { order_id: '2231' });
    assert.equal(res.ok, true);
    assert.equal(res.data.delivery_record.is_overdue, true);
    assert.ok(res.data.delivery_record.days_overdue > 0);
  });
});

describe('get_order_timeline', () => {
  test('returns events in chronological order', async () => {
    const res = await tools.execute('get_order_timeline', { order_id: '4521' });
    assert.equal(res.ok, true);
    assert.ok(res.data.timeline.length >= 2);
    for (let i = 1; i < res.data.timeline.length; i++) {
      assert.ok(new Date(res.data.timeline[i - 1].at) <= new Date(res.data.timeline[i].at));
    }
    assert.equal(res.data.timeline[0].type, 'ORDER_PLACED');
  });
});

describe('search_orders', () => {
  test('finds every paid order with no delivery record', async () => {
    const res = await tools.execute('search_orders', {
      payment_status: 'PAID',
      delivery_status: 'NONE',
    });
    assert.equal(res.ok, true);
    assert.ok(res.data.result_count > 0);
    for (const o of res.data.orders) {
      assert.equal(o.payment_status, 'PAID');
      assert.equal(o.delivery_status, 'NONE');
    }
    assert.ok(res.data.orders.some((o) => o.order_id === 'ORD-1289'));
  });

  test('caps limit at 50 even when asked for more', async () => {
    const res = await tools.execute('search_orders', { limit: 500 });
    assert.ok(res.data.orders.length <= 50);
  });
});

describe('get_operational_summary', () => {
  test('reports fleet-wide risk counters', async () => {
    const res = await tools.execute('get_operational_summary', {});
    assert.equal(res.ok, true);
    assert.equal(res.data.totals.orders, repo.meta.counts.orders);
    assert.ok(res.data.risk.paid_without_delivery_count > 0);
    assert.ok(res.data.risk.paid_without_delivery_value_inr > 0);
    assert.ok(res.data.risk.overdue_delivery_count > 0);
  });
});

describe('error handling', () => {
  test('an unknown tool name is a result, not a throw', async () => {
    const res = await tools.execute('no_such_tool', {});
    assert.equal(res.ok, false);
    assert.equal(res.error.code, 'UNKNOWN_TOOL');
  });

  test('missing required arguments produce a structured error', async () => {
    const res = await tools.execute('get_order_summary', {});
    assert.equal(res.ok, false);
    assert.equal(res.error.code, 'INVALID_ORDER_REFERENCE');
  });
});

describe('tool declarations', () => {
  test('every declared tool has an implementation', () => {
    for (const decl of tools.declarations) {
      assert.equal(typeof tools.impl[decl.name], 'function', 'missing impl: ' + decl.name);
    }
  });

  test('every declaration carries a description the model can route on', () => {
    for (const decl of tools.declarations) {
      assert.ok(decl.description.length > 40, decl.name + ' needs a fuller description');
      assert.equal(decl.parameters.type, 'object');
    }
  });
});
