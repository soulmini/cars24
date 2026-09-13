/**
 * Deterministic diagnostic rules.
 *
 * Design note: the LLM does NOT decide whether an order is in trouble. That
 * judgement is encoded here as explicit, testable rules, and the model only
 * gets to phrase the result. Two reasons:
 *
 *   1. An ops team acts on these answers. "Payment captured 6 days ago with
 *      no delivery scheduled" must be a fact derived from rows, not a
 *      plausible-sounding sentence.
 *   2. Rules are unit-testable; prompt output is not.
 *
 * Each rule returns a finding with a stable `code`, a severity, and the
 * evidence it fired on, so the API response can be audited row by row.
 */

const DAY_MS = 24 * 3600 * 1000;

export const SEVERITY = {
  CRITICAL: 'CRITICAL',
  HIGH: 'HIGH',
  MEDIUM: 'MEDIUM',
  LOW: 'LOW',
  INFO: 'INFO',
};

const SEVERITY_RANK = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3, INFO: 4 };

const daysBetween = (a, b) => Math.floor((new Date(b) - new Date(a)) / DAY_MS);
const inr = (n) => 'INR ' + Number(n).toLocaleString('en-IN');

/**
 * Collapses the payment attempt history into a single verdict.
 *
 * An order can have several payment rows (failed attempt, then a successful
 * retry). Callers almost always want "what is the money doing right now",
 * which is the latest terminal state, not the first row.
 */
export function summarizePayments(payments) {
  if (!payments.length) {
    return {
      state: 'NO_PAYMENT_RECORD',
      captured: false,
      amount_paid: 0,
      amount_refunded: 0,
      attempts: 0,
      latest: null,
      failed_attempts: [],
    };
  }

  const latest = payments[payments.length - 1];
  const failed = payments.filter((p) => p.status === 'FAILED');
  const captured = payments.filter((p) =>
    ['CAPTURED', 'PARTIALLY_REFUNDED', 'REFUNDED'].includes(p.status),
  );

  const amountRefunded = payments.reduce((s, p) => s + (p.refunded_amount ?? 0), 0);
  const amountPaid = captured.reduce((s, p) => s + p.amount, 0);

  return {
    state: latest.status,
    captured: captured.length > 0,
    amount_paid: amountPaid,
    amount_refunded: amountRefunded,
    net_amount: amountPaid - amountRefunded,
    attempts: payments.length,
    method: latest.method,
    gateway: latest.gateway,
    latest,
    failed_attempts: failed.map((p) => ({
      payment_id: p.payment_id,
      attempted_at: p.attempted_at,
      failure_code: p.failure_code,
      failure_reason: p.failure_reason,
    })),
  };
}

/**
 * The rule set. Each rule is a pure function of the order graph plus `now`,
 * returning a finding or null. Adding an operational check means adding one
 * function here and one test - nothing else in the system changes.
 */
const RULES = [
  /* The headline case from the problem statement. */
  function paidButNoDeliveryScheduled({ order, payment, delivery, now }) {
    if (!payment.captured || payment.state === 'REFUNDED') return null;
    if (delivery) return null;
    if (['CANCELLED', 'RETURNED'].includes(order.status)) return null;

    const capturedAt = payment.latest?.completed_at ?? payment.latest?.attempted_at;
    const stuckDays = daysBetween(capturedAt, now);

    return {
      code: 'PAID_NO_DELIVERY_SCHEDULED',
      severity: stuckDays >= 3 ? SEVERITY.CRITICAL : SEVERITY.HIGH,
      title: 'Payment captured but no delivery has been scheduled',
      detail:
        'We captured ' + inr(payment.net_amount) + ' on ' +
        String(capturedAt).slice(0, 10) + ' (' + stuckDays + ' day(s) ago) but there is no ' +
        'delivery record for this order. The order is sitting in ' + order.status + '.',
      evidence: {
        payment_id: payment.latest?.payment_id,
        captured_at: capturedAt,
        days_stuck: stuckDays,
        order_status: order.status,
        delivery_record: null,
      },
      recommended_action:
        'Check the fulfilment hold on this order, allocate inventory and book a courier slot today. ' +
        'If it cannot ship within 24h, proactively contact the customer with a revised date or offer a refund.',
    };
  },

  /* Fulfilment explicitly blocked - explains the above when present. */
  function warehouseHold({ events }) {
    const hold = [...events].reverse().find((e) => e.type === 'WAREHOUSE_HOLD');
    if (!hold) return null;
    return {
      code: 'WAREHOUSE_HOLD',
      severity: SEVERITY.HIGH,
      title: 'Fulfilment is blocked at the warehouse',
      detail: hold.description,
      evidence: { event_id: hold.event_id, at: hold.at, source: hold.source },
      recommended_action:
        'Resolve the blocking condition (inventory, serviceability or risk review) before promising a date.',
    };
  },

  function deliveryOverdue({ delivery, now }) {
    if (!delivery) return null;
    if (['DELIVERED', 'RTO'].includes(delivery.status)) return null;
    const promised = new Date(delivery.promised_date);
    if (promised >= new Date(now)) return null;

    const lateDays = daysBetween(promised, now);
    return {
      code: 'DELIVERY_OVERDUE',
      severity: lateDays >= 3 ? SEVERITY.CRITICAL : SEVERITY.HIGH,
      title: 'Delivery is past its promised date',
      detail:
        'Promised ' + delivery.promised_date.slice(0, 10) + ', now ' + lateDays +
        ' day(s) overdue. Current status is ' + delivery.status +
        (delivery.current_location ? ' at ' + delivery.current_location : '') +
        (delivery.failure_reason ? '. Courier reason: ' + delivery.failure_reason : '') + '.',
      evidence: {
        delivery_id: delivery.delivery_id,
        promised_date: delivery.promised_date,
        days_overdue: lateDays,
        status: delivery.status,
        courier: delivery.courier,
        tracking_number: delivery.tracking_number,
      },
      recommended_action:
        'Raise a courier escalation with AWB ' + delivery.tracking_number +
        ' and give the customer a firm revised ETA.',
    };
  },

  function deliveryAttemptsExhausted({ delivery }) {
    if (!delivery) return null;
    if (delivery.attempts < 2 || delivery.status === 'DELIVERED') return null;
    return {
      code: 'DELIVERY_ATTEMPTS_HIGH',
      severity: delivery.attempts >= 3 ? SEVERITY.CRITICAL : SEVERITY.MEDIUM,
      title: 'Multiple failed delivery attempts',
      detail:
        delivery.attempts + ' attempt(s) made, most recent on ' +
        String(delivery.last_attempt_at).slice(0, 10) + '. Reason: ' +
        (delivery.failure_reason ?? 'not recorded') + '.',
      evidence: {
        delivery_id: delivery.delivery_id,
        attempts: delivery.attempts,
        last_attempt_at: delivery.last_attempt_at,
        failure_reason: delivery.failure_reason,
      },
      recommended_action:
        delivery.attempts >= 3
          ? 'Next failure triggers RTO. Call the customer to confirm the address and a delivery window before re-attempting.'
          : 'Confirm the address and an available time window with the customer before the next attempt.',
    };
  },

  function paymentFailed({ payment, order }) {
    if (payment.state !== 'FAILED') return null;
    const last = payment.latest;
    return {
      code: 'PAYMENT_FAILED',
      severity: SEVERITY.HIGH,
      title: 'Payment failed and was not retried successfully',
      detail:
        'Latest attempt (' + last.payment_id + ') failed with ' +
        (last.failure_code ?? 'UNKNOWN') + ': ' + (last.failure_reason ?? 'no reason recorded') +
        '. Order is held in ' + order.status + '.',
      evidence: {
        payment_id: last.payment_id,
        failure_code: last.failure_code,
        failure_reason: last.failure_reason,
        total_attempts: payment.attempts,
      },
      recommended_action:
        'Send the customer a fresh payment link. If they report a debit despite the failure, ' +
        'raise a gateway reconciliation request - auto-reversal usually lands within 5-7 working days.',
    };
  },

  function paymentPending({ payment, order, now }) {
    if (payment.state !== 'PENDING' || payment.method === 'COD') return null;
    const pendingDays = daysBetween(payment.latest.attempted_at, now);
    if (pendingDays < 1) return null;
    return {
      code: 'PAYMENT_STUCK_PENDING',
      severity: pendingDays >= 3 ? SEVERITY.HIGH : SEVERITY.MEDIUM,
      title: 'Payment has been pending for an unusually long time',
      detail:
        'Initiated ' + pendingDays + ' day(s) ago via ' + payment.method +
        ' and the gateway has still not confirmed. Order remains ' + order.status + '.',
      evidence: {
        payment_id: payment.latest.payment_id,
        attempted_at: payment.latest.attempted_at,
        days_pending: pendingDays,
        gateway: payment.gateway,
      },
      recommended_action:
        'Query the gateway for the final status of this transaction, then either confirm the order or release it.',
    };
  },

  function refundPending({ payment, now }) {
    if (payment.state !== 'REFUND_PENDING') return null;
    const days = daysBetween(payment.latest.attempted_at, now);
    return {
      code: 'REFUND_PENDING',
      severity: days >= 7 ? SEVERITY.HIGH : SEVERITY.MEDIUM,
      title: 'Refund initiated but not yet settled',
      detail: 'A refund of ' + inr(payment.latest.amount) + ' is still unsettled.',
      evidence: { payment_id: payment.latest.payment_id, amount: payment.latest.amount },
      recommended_action:
        'Confirm the refund ARN with the gateway and share it with the customer so their bank can trace it.',
    };
  },

  function openHighPriorityTicket({ tickets }) {
    const open = tickets.filter((t) => t.status === 'OPEN');
    if (!open.length) return null;
    const highest = open.find((t) => t.priority === 'HIGH') ?? open[0];
    return {
      code: 'OPEN_TICKET',
      severity: highest.priority === 'HIGH' ? SEVERITY.HIGH : SEVERITY.MEDIUM,
      title: open.length + ' open support ticket(s) on this order',
      detail:
        'Most pressing: "' + highest.subject + '" (' + highest.priority + ', raised ' +
        highest.created_at.slice(0, 10) + ' via ' + highest.channel + ').',
      evidence: {
        open_ticket_ids: open.map((t) => t.ticket_id),
        highest_priority: highest.priority,
        assigned_to: highest.assigned_to,
      },
      recommended_action: highest.assigned_to
        ? 'Follow up with ' + highest.assigned_to + ' on ticket ' + highest.ticket_id + '.'
        : 'Ticket ' + highest.ticket_id + ' is unassigned - assign an owner now.',
    };
  },

  function unpaidButShipped({ payment, delivery, order }) {
    if (payment.method === 'COD') return null; // COD is unpaid by design
    if (payment.captured) return null;
    if (!delivery || !['IN_TRANSIT', 'DISPATCHED', 'DELIVERED'].includes(delivery.status)) return null;
    return {
      code: 'SHIPPED_WITHOUT_PAYMENT',
      severity: SEVERITY.CRITICAL,
      title: 'Goods shipped without a captured payment',
      detail:
        'Delivery is ' + delivery.status + ' but payment state is ' + payment.state +
        '. Revenue leakage risk of ' + inr(order.totals.grand_total) + '.',
      evidence: {
        delivery_status: delivery.status,
        payment_state: payment.state,
        exposure_inr: order.totals.grand_total,
      },
      recommended_action:
        'Escalate to finance immediately and attempt collection before the parcel is handed over.',
    };
  },
];

/**
 * Runs every rule over one order graph and returns findings ordered by
 * severity. An empty array means "nothing anomalous", which is itself a
 * useful answer for the copilot to state plainly.
 */
export function diagnose({ order, payments, delivery, tickets, events, now }) {
  const payment = summarizePayments(payments);
  const ctx = { order, payments, payment, delivery, tickets, events, now };

  const findings = [];
  for (const rule of RULES) {
    try {
      const finding = rule(ctx);
      if (finding) findings.push(finding);
    } catch (err) {
      // A broken rule must never take down the whole answer.
      findings.push({
        code: 'RULE_ERROR',
        severity: SEVERITY.INFO,
        title: 'Diagnostic rule failed to evaluate',
        detail: rule.name + ': ' + err.message,
        evidence: {},
        recommended_action: 'Report this to the engineering team.',
      });
    }
  }

  findings.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
  return { payment_summary: payment, findings };
}

/**
 * A single headline verdict for the whole order, used as the `health` field
 * in tool output so the model has an unambiguous signal to lead with.
 */
export function healthFrom(findings) {
  if (!findings.length) return 'HEALTHY';
  const worst = findings[0].severity;
  if (worst === SEVERITY.CRITICAL) return 'CRITICAL';
  if (worst === SEVERITY.HIGH) return 'NEEDS_ATTENTION';
  if (worst === SEVERITY.MEDIUM) return 'WATCH';
  return 'HEALTHY';
}
