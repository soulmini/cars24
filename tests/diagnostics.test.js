/**
 * Diagnostic rule tests.
 *
 * These are the highest-value tests in the repo: the rules here are what an
 * ops team actually acts on, and unlike prompt output they are deterministic
 * and therefore assertable.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { diagnose, summarizePayments, healthFrom, SEVERITY } from '../src/lib/diagnostics.js';

const NOW = new Date('2024-05-17T10:30:00.000Z');

const baseOrder = (over = {}) => ({
  order_id: 'ORD-1000',
  status: 'PROCESSING',
  payment_status: 'PAID',
  placed_at: '2024-05-07T10:00:00.000Z',
  items: [{ name: 'Test Item', quantity: 1, line_total: 10000 }],
  totals: { grand_total: 11800, currency: 'INR' },
  ...over,
});

const capturedPayment = (over = {}) => ({
  payment_id: 'PAY-1000-1',
  order_id: 'ORD-1000',
  method: 'UPI',
  gateway: 'Razorpay',
  amount: 11800,
  status: 'CAPTURED',
  attempted_at: '2024-05-07T10:05:00.000Z',
  completed_at: '2024-05-07T10:05:00.000Z',
  failure_code: null,
  failure_reason: null,
  refunded_amount: 0,
  ...over,
});

const run = (over = {}) =>
  diagnose({
    order: baseOrder(),
    payments: [capturedPayment()],
    delivery: null,
    tickets: [],
    events: [],
    now: NOW,
    ...over,
  });

const codes = (findings) => findings.map((f) => f.code);

describe('summarizePayments', () => {
  test('reports no record when there are no payment rows', () => {
    const s = summarizePayments([]);
    assert.equal(s.state, 'NO_PAYMENT_RECORD');
    assert.equal(s.captured, false);
    assert.equal(s.amount_paid, 0);
  });

  test('uses the latest attempt as the current state, not the first', () => {
    const s = summarizePayments([
      capturedPayment({ payment_id: 'PAY-1', status: 'FAILED', failure_code: 'CARD_DECLINED' }),
      capturedPayment({ payment_id: 'PAY-2', status: 'CAPTURED' }),
    ]);
    assert.equal(s.state, 'CAPTURED');
    assert.equal(s.captured, true);
    assert.equal(s.attempts, 2);
    assert.equal(s.failed_attempts.length, 1);
    assert.equal(s.failed_attempts[0].failure_code, 'CARD_DECLINED');
  });

  test('nets refunds against captured amounts', () => {
    const s = summarizePayments([
      capturedPayment({ status: 'PARTIALLY_REFUNDED', refunded_amount: 5000 }),
    ]);
    assert.equal(s.amount_paid, 11800);
    assert.equal(s.amount_refunded, 5000);
    assert.equal(s.net_amount, 6800);
  });
});

describe('PAID_NO_DELIVERY_SCHEDULED', () => {
  test('fires when payment is captured and no delivery exists', () => {
    const { findings } = run();
    assert.ok(codes(findings).includes('PAID_NO_DELIVERY_SCHEDULED'));
  });

  test('escalates to CRITICAL once stuck three days or more', () => {
    const { findings } = run();
    const f = findings.find((x) => x.code === 'PAID_NO_DELIVERY_SCHEDULED');
    assert.equal(f.severity, SEVERITY.CRITICAL);
    assert.equal(f.evidence.days_stuck, 10);
  });

  test('stays HIGH when only recently stuck', () => {
    const { findings } = run({
      payments: [capturedPayment({
        attempted_at: '2024-05-16T10:00:00.000Z',
        completed_at: '2024-05-16T10:00:00.000Z',
      })],
    });
    const f = findings.find((x) => x.code === 'PAID_NO_DELIVERY_SCHEDULED');
    assert.equal(f.severity, SEVERITY.HIGH);
  });

  test('does not fire when a delivery is scheduled', () => {
    const { findings } = run({
      delivery: {
        delivery_id: 'DLV-1000',
        status: 'SCHEDULED',
        promised_date: '2024-05-20T10:00:00.000Z',
        attempts: 0,
        courier: 'BlueDart',
        tracking_number: '123',
      },
    });
    assert.ok(!codes(findings).includes('PAID_NO_DELIVERY_SCHEDULED'));
  });

  test('does not fire for cancelled orders', () => {
    const { findings } = run({ order: baseOrder({ status: 'CANCELLED' }) });
    assert.ok(!codes(findings).includes('PAID_NO_DELIVERY_SCHEDULED'));
  });

  test('does not fire when the payment was refunded', () => {
    const { findings } = run({
      payments: [capturedPayment({ status: 'REFUNDED', refunded_amount: 11800 })],
    });
    assert.ok(!codes(findings).includes('PAID_NO_DELIVERY_SCHEDULED'));
  });

  test('carries a recommended action an ops agent can execute', () => {
    const { findings } = run();
    const f = findings.find((x) => x.code === 'PAID_NO_DELIVERY_SCHEDULED');
    assert.match(f.recommended_action, /courier|refund|contact/i);
  });
});

describe('DELIVERY_OVERDUE', () => {
  const overdueDelivery = (over = {}) => ({
    delivery_id: 'DLV-1000',
    status: 'IN_TRANSIT',
    courier: 'Delhivery',
    tracking_number: '987654321',
    promised_date: '2024-05-12T10:00:00.000Z',
    attempts: 0,
    current_location: 'Pune hub',
    failure_reason: null,
    ...over,
  });

  test('fires and reports the correct lateness', () => {
    const { findings } = run({ delivery: overdueDelivery() });
    const f = findings.find((x) => x.code === 'DELIVERY_OVERDUE');
    assert.ok(f);
    assert.equal(f.evidence.days_overdue, 5);
    assert.equal(f.severity, SEVERITY.CRITICAL);
  });

  test('does not fire for a delivered order', () => {
    const { findings } = run({ delivery: overdueDelivery({ status: 'DELIVERED' }) });
    assert.ok(!codes(findings).includes('DELIVERY_OVERDUE'));
  });

  test('does not fire when the promised date is still ahead', () => {
    const { findings } = run({ delivery: overdueDelivery({ promised_date: '2024-05-25T10:00:00.000Z' }) });
    assert.ok(!codes(findings).includes('DELIVERY_OVERDUE'));
  });
});

describe('payment failure rules', () => {
  test('PAYMENT_FAILED fires on an unrecovered failure', () => {
    const { findings } = run({
      order: baseOrder({ status: 'PAYMENT_FAILED', payment_status: 'FAILED' }),
      payments: [capturedPayment({
        status: 'FAILED',
        failure_code: 'INSUFFICIENT_FUNDS',
        failure_reason: 'Issuing bank declined: insufficient funds.',
      })],
    });
    const f = findings.find((x) => x.code === 'PAYMENT_FAILED');
    assert.ok(f);
    assert.equal(f.evidence.failure_code, 'INSUFFICIENT_FUNDS');
  });

  test('PAYMENT_FAILED does not fire when a retry succeeded', () => {
    const { findings } = run({
      payments: [
        capturedPayment({ payment_id: 'PAY-1', status: 'FAILED', failure_code: 'AUTH_TIMEOUT' }),
        capturedPayment({ payment_id: 'PAY-2', status: 'CAPTURED' }),
      ],
    });
    assert.ok(!codes(findings).includes('PAYMENT_FAILED'));
  });

  test('PAYMENT_STUCK_PENDING ignores COD, which is pending by design', () => {
    const { findings } = run({
      payments: [capturedPayment({ status: 'PENDING', method: 'COD' })],
    });
    assert.ok(!codes(findings).includes('PAYMENT_STUCK_PENDING'));
  });

  test('PAYMENT_STUCK_PENDING fires for a long-pending online payment', () => {
    const { findings } = run({
      payments: [capturedPayment({ status: 'PENDING', method: 'UPI' })],
    });
    const f = findings.find((x) => x.code === 'PAYMENT_STUCK_PENDING');
    assert.ok(f);
    assert.equal(f.severity, SEVERITY.HIGH);
  });
});

describe('SHIPPED_WITHOUT_PAYMENT', () => {
  test('fires as CRITICAL when goods moved without capture', () => {
    const { findings } = run({
      payments: [capturedPayment({ status: 'PENDING', method: 'UPI' })],
      delivery: {
        delivery_id: 'DLV-1000',
        status: 'IN_TRANSIT',
        promised_date: '2024-05-25T10:00:00.000Z',
        attempts: 0,
        courier: 'Ekart',
        tracking_number: '111',
      },
    });
    const f = findings.find((x) => x.code === 'SHIPPED_WITHOUT_PAYMENT');
    assert.ok(f);
    assert.equal(f.severity, SEVERITY.CRITICAL);
  });

  test('does not fire for COD, where shipping before payment is normal', () => {
    const { findings } = run({
      payments: [capturedPayment({ status: 'PENDING', method: 'COD' })],
      delivery: {
        delivery_id: 'DLV-1000',
        status: 'IN_TRANSIT',
        promised_date: '2024-05-25T10:00:00.000Z',
        attempts: 0,
        courier: 'Ekart',
        tracking_number: '111',
      },
    });
    assert.ok(!codes(findings).includes('SHIPPED_WITHOUT_PAYMENT'));
  });
});

describe('healthy orders and ordering', () => {
  test('a delivered, paid order produces no findings', () => {
    const { findings } = run({
      order: baseOrder({ status: 'DELIVERED' }),
      delivery: {
        delivery_id: 'DLV-1000',
        status: 'DELIVERED',
        promised_date: '2024-05-12T10:00:00.000Z',
        delivered_at: '2024-05-11T10:00:00.000Z',
        attempts: 1,
        courier: 'BlueDart',
        tracking_number: '222',
      },
    });
    assert.deepEqual(findings, []);
    assert.equal(healthFrom(findings), 'HEALTHY');
  });

  test('findings are sorted most severe first', () => {
    const { findings } = run({
      tickets: [{
        ticket_id: 'TKT-1', status: 'OPEN', priority: 'MEDIUM', subject: 'Question',
        created_at: '2024-05-10T10:00:00.000Z', channel: 'EMAIL', assigned_to: 'ops.team1',
      }],
    });
    assert.ok(findings.length >= 2);
    const rank = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3, INFO: 4 };
    for (let i = 1; i < findings.length; i++) {
      assert.ok(rank[findings[i - 1].severity] <= rank[findings[i].severity]);
    }
  });

  test('healthFrom maps the worst severity to a verdict', () => {
    assert.equal(healthFrom([]), 'HEALTHY');
    assert.equal(healthFrom([{ severity: 'CRITICAL' }]), 'CRITICAL');
    assert.equal(healthFrom([{ severity: 'HIGH' }]), 'NEEDS_ATTENTION');
    assert.equal(healthFrom([{ severity: 'MEDIUM' }]), 'WATCH');
  });
});
