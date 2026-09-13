/**
 * Deterministic offline provider.
 *
 * Why this exists: an assessment repo that only works if the reviewer has an
 * API key is a repo the reviewer cannot run. This provider implements the
 * same interface with hand-written intent routing, so `npm start` and
 * `npm test` work with zero configuration and zero network.
 *
 * It is genuinely useful beyond the demo:
 *   - the agent loop, tool layer and API are tested without paying for or
 *     depending on a live model,
 *   - tests stay deterministic, so a failure means a real regression,
 *   - it is the documented fallback when Gemini is unreachable.
 *
 * It is NOT a language model. It routes on keywords and renders tool output
 * with templates. Answers are correct but stilted - that is the tradeoff, and
 * the response payload always says which provider produced the answer.
 */
import { LLMProvider } from './provider.js';

const ORDER_REF = /(?:#|order\s*|ord[-\s]?)(\d{3,})|\b(\d{4})\b/i;

function extractOrderRef(text) {
  const m = String(text).match(ORDER_REF);
  if (!m) return null;
  return m[1] ?? m[2] ?? null;
}

const has = (text, ...words) => {
  const t = String(text).toLowerCase();
  return words.some((w) => t.includes(w));
};

/* ------------------------------------------------------------------ *
 * Renderers - turn tool JSON into an ops-readable answer.
 * ------------------------------------------------------------------ */

function renderFindings(findings) {
  if (!findings?.length) return [];
  const lines = ['', 'Issues detected:'];
  for (const f of findings) {
    lines.push('- [' + f.severity + '] ' + f.title + ' - ' + f.detail);
    lines.push('  Next step: ' + f.recommended_action);
  }
  return lines;
}

function renderSummary(d) {
  const lines = [];
  lines.push('Order ' + d.order_id + ' - ' + d.health.replace(/_/g, ' ').toLowerCase() + '.');
  lines.push('');
  lines.push('Order status: ' + d.order.status + ', placed ' + d.order.placed_at.slice(0, 10) +
    ' via ' + d.order.channel + '.');
  if (d.customer) {
    lines.push('Customer: ' + d.customer.name + ' (' + d.customer.tier + ', ' + d.customer.city + ').');
  }
  lines.push('Items: ' + d.order.items.join('; ') + '. Total ' + d.order.grand_total_formatted + '.');
  lines.push('Payment: ' + d.payment.state + ' via ' + d.payment.method +
    ', ' + d.payment.amount_paid_formatted + ' captured' +
    (d.payment.failed_attempt_count ? ' after ' + d.payment.failed_attempt_count + ' failed attempt(s)' : '') + '.');

  if (d.delivery) {
    lines.push('Delivery: ' + d.delivery.status + ' with ' + d.delivery.courier +
      ' (AWB ' + d.delivery.tracking_number + '), promised ' + d.delivery.promised_date.slice(0, 10) +
      (d.delivery.delivered_at ? ', delivered ' + d.delivery.delivered_at.slice(0, 10) : '') + '.');
  } else {
    lines.push('Delivery: nothing scheduled - there is no delivery record for this order.');
  }

  if (d.open_tickets.length) {
    lines.push('Open tickets: ' + d.open_tickets
      .map((t) => t.ticket_id + ' (' + t.priority + ') "' + t.subject + '"').join('; ') + '.');
  }

  lines.push(...renderFindings(d.findings));
  return lines.join('\n');
}

function renderPayment(d) {
  const lines = [];
  lines.push('Payment for order ' + d.order_id + ': ' + d.summary.state +
    ' via ' + d.summary.method + (d.summary.gateway ? ' (' + d.summary.gateway + ')' : '') + '.');
  lines.push('Order total ' + d.order_total_formatted + '; net collected ' + d.summary.net_amount_formatted + '.');
  lines.push('');
  lines.push('Attempt history:');
  for (const a of d.attempts) {
    let line = '- ' + a.attempted_at.slice(0, 16).replace('T', ' ') + ' ' + a.payment_id +
      ': ' + a.status + ' ' + a.amount_formatted;
    if (a.gateway_txn_id) line += ' [txn ' + a.gateway_txn_id + ']';
    if (a.failure_reason) line += ' - ' + a.failure_reason;
    lines.push(line);
  }
  return lines.join('\n');
}

function renderDelivery(d) {
  if (!d.delivery_record) {
    return 'Order ' + d.order_id + ': no delivery scheduled. ' + d.note;
  }
  const r = d.delivery_record;
  const lines = [];
  lines.push('Delivery for order ' + d.order_id + ': ' + r.status + ' with ' + r.courier +
    ', AWB ' + r.tracking_number + '.');
  lines.push('Promised ' + r.promised_date.slice(0, 10) +
    (r.is_overdue ? ' - overdue by ' + r.days_overdue + ' day(s)' : '') + '.');
  if (r.dispatched_at) lines.push('Dispatched ' + r.dispatched_at.slice(0, 10) + '.');
  if (r.delivered_at) lines.push('Delivered ' + r.delivered_at.slice(0, 10) + '.');
  if (r.current_location) lines.push('Last known location: ' + r.current_location + '.');
  if (r.attempts) lines.push('Attempts: ' + r.attempts +
    (r.failure_reason ? ' (latest failure: ' + r.failure_reason + ')' : '') + '.');
  return lines.join('\n');
}

function renderTimeline(d) {
  const lines = ['Timeline for order ' + d.order_id + ' (' + d.event_count + ' events):'];
  for (const e of d.timeline) {
    lines.push('- ' + e.at.slice(0, 16).replace('T', ' ') + ' [' + e.type + '] ' + e.description);
  }
  if (d.tickets.length) {
    lines.push('', 'Related tickets:');
    for (const t of d.tickets) {
      lines.push('- ' + t.ticket_id + ' (' + t.status + '/' + t.priority + ') ' + t.subject);
    }
  }
  return lines.join('\n');
}

function renderSearch(d) {
  if (!d.result_count) return 'No orders matched those filters.';
  const lines = ['Found ' + d.result_count + ' order(s)' + (d.truncated ? ' (truncated)' : '') + ':'];
  for (const o of d.orders) {
    lines.push('- ' + o.order_id + ': ' + o.status + ', payment ' + o.payment_status +
      ', delivery ' + o.delivery_status + ', ' + o.grand_total_formatted);
  }
  return lines.join('\n');
}

function renderOps(d) {
  const lines = [];
  lines.push('Operational summary as of ' + d.as_of.slice(0, 10) + '.');
  lines.push('Orders: ' + d.totals.orders + ' across ' + d.totals.customers + ' customers. ' +
    'Open tickets: ' + d.totals.open_tickets + ' (' + d.risk.high_priority_open_tickets + ' high priority).');
  lines.push('');
  lines.push('Orders by status: ' + Object.entries(d.orders_by_status)
    .map(([k, v]) => k + '=' + v).join(', ') + '.');
  lines.push('Deliveries by status: ' + Object.entries(d.deliveries_by_status)
    .map(([k, v]) => k + '=' + v).join(', ') + '.');
  lines.push('');
  lines.push('Risk:');
  lines.push('- ' + d.risk.paid_without_delivery_count + ' order(s) paid with no delivery scheduled, worth INR ' +
    Number(d.risk.paid_without_delivery_value_inr).toLocaleString('en-IN') + '.');
  if (d.risk.paid_without_delivery_orders.length) {
    lines.push('  Examples: ' + d.risk.paid_without_delivery_orders.join(', ') + '.');
  }
  lines.push('- ' + d.risk.overdue_delivery_count + ' delivery/deliveries past the promised date.');
  return lines.join('\n');
}

const RENDERERS = {
  get_order_summary: renderSummary,
  get_payment_details: renderPayment,
  get_delivery_details: renderDelivery,
  get_order_timeline: renderTimeline,
  search_orders: renderSearch,
  get_operational_summary: renderOps,
  find_customer: (d) =>
    d.result_count
      ? 'Matched ' + d.result_count + ' customer(s):\n' +
        d.customers.map((c) => '- ' + c.customer_id + ' ' + c.name + ' <' + c.email + '> ' + c.tier + ', ' + c.city).join('\n')
      : 'No customer matched "' + d.query + '".',
};

/**
 * Chooses which tool a question needs. Order matters: more specific intents
 * are tested before the catch-all summary.
 */
function planToolCall(question) {
  const ref = extractOrderRef(question);

  if (has(question, 'overall', 'summary of operations', 'operational', 'how many orders',
    'across all', 'fleet', 'dashboard', 'business') && !ref) {
    return { name: 'get_operational_summary', args: {} };
  }

  if (!ref) {
    if (has(question, 'paid but', 'not scheduled', 'no delivery', 'stuck')) {
      return { name: 'search_orders', args: { payment_status: 'PAID', delivery_status: 'NONE' } };
    }
    if (has(question, 'delayed', 'late', 'overdue')) {
      return { name: 'search_orders', args: { delivery_status: 'DELAYED' } };
    }
    if (has(question, 'failed payment', 'payment failed')) {
      return { name: 'search_orders', args: { payment_status: 'FAILED' } };
    }
    if (has(question, 'customer', 'who is', 'email')) {
      const nameMatch = String(question).match(/(?:for|from|about)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/);
      if (nameMatch) return { name: 'find_customer', args: { query: nameMatch[1] } };
    }
    return { name: 'get_operational_summary', args: {} };
  }

  // Specific intents take priority over the general summary.
  if (has(question, 'timeline', 'history', 'what happened', 'sequence', 'log')) {
    return { name: 'get_order_timeline', args: { order_id: ref } };
  }
  if (has(question, 'track', 'tracking', 'awb', 'courier', 'where is')) {
    return { name: 'get_delivery_details', args: { order_id: ref } };
  }
  if (has(question, 'transaction id', 'txn', 'gateway', 'refund amount', 'attempts')) {
    return { name: 'get_payment_details', args: { order_id: ref } };
  }

  // Payment-only questions still route to the summary, because the summary
  // carries the cross-signal diagnosis the payment tool alone would miss.
  return { name: 'get_order_summary', args: { order_id: ref } };
}

export class MockProvider extends LLMProvider {
  get name() {
    return 'mock:deterministic';
  }

  async generate({ messages }) {
    const lastTool = [...messages].reverse().find((m) => m.role === 'tool');
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');

    // Second pass: tool results are in hand, so produce the final answer.
    if (lastTool) {
      const parts = [];
      for (const r of lastTool.results) {
        if (r.result?.ok === false) {
          parts.push('I could not complete that: ' + r.result.error.message);
          continue;
        }
        const render = RENDERERS[r.name];
        const payload = r.result?.data ?? r.result;
        parts.push(render ? render(payload) : JSON.stringify(payload, null, 2));
      }
      return {
        text: parts.join('\n\n'),
        toolCalls: [],
        usage: { input_tokens: 0, output_tokens: 0 },
        finishReason: 'STOP',
      };
    }

    // First pass: decide which tool to call.
    const question = lastUser?.content ?? '';
    const plan = planToolCall(question);
    return {
      text: null,
      toolCalls: [{ id: 'mock-' + plan.name, name: plan.name, args: plan.args }],
      usage: { input_tokens: 0, output_tokens: 0 },
      finishReason: 'TOOL_CALLS',
    };
  }
}

export default MockProvider;
