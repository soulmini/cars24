/**
 * The copilot's tool surface.
 *
 * Every tool is a plain async function plus a JSON-Schema declaration. The
 * declarations go to Gemini as function-calling specs; the implementations
 * run locally against the repository. The model never sees the dataset - it
 * only ever sees what a tool chose to return.
 *
 * Two deliberate constraints:
 *
 *   - Tools are read-only. Nothing here mutates state, so a hallucinated tool
 *     call is at worst a wasted round trip, never a wrong write.
 *   - Tool output is bounded. `get_order_summary` returns a digest rather than
 *     the raw graph, which keeps token cost flat as the dataset grows and
 *     stops the model drowning in irrelevant rows.
 */
import { normalizeOrderId } from '../data/repository.js';
import { diagnose, healthFrom } from '../lib/diagnostics.js';

/** Thrown for expected, user-facing failures (unknown order, bad argument). */
export class ToolError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ToolError';
    this.code = code;
    this.details = details;
  }
}

const inr = (n) => 'INR ' + Number(n).toLocaleString('en-IN');

/** Loads the full order graph or throws a structured not-found. */
function loadGraph(repo, orderRef) {
  const orderId = normalizeOrderId(orderRef);
  if (!orderId) {
    throw new ToolError(
      'INVALID_ORDER_REFERENCE',
      'Could not read an order number from "' + orderRef + '". Expected something like 4521, #4521 or ORD-4521.',
      { provided: orderRef },
    );
  }

  const order = repo.getOrder(orderId);
  if (!order) {
    throw new ToolError('ORDER_NOT_FOUND', 'No order exists with id ' + orderId + '.', { order_id: orderId });
  }

  return {
    orderId,
    order,
    customer: repo.getCustomer(order.customer_id),
    payments: repo.getPayments(orderId),
    delivery: repo.getDelivery(orderId),
    tickets: repo.getTickets(orderId),
    events: repo.getEvents(orderId),
  };
}

/* ------------------------------------------------------------------ *
 * Tool declarations (sent to the model)
 * ------------------------------------------------------------------ */
export const TOOL_DECLARATIONS = [
  {
    name: 'get_order_summary',
    description:
      'Full status digest for one order: order state, payment state, delivery state, open tickets, ' +
      'a health verdict and any automatically detected problems with recommended actions. ' +
      'This is the primary tool - prefer it for almost every order question, including ' +
      '"what is the payment status", "where is my delivery" and "give me a full summary".',
    parameters: {
      type: 'object',
      properties: {
        order_id: {
          type: 'string',
          description: 'Order reference in any common form: 4521, #4521 or ORD-4521.',
        },
      },
      required: ['order_id'],
    },
  },
  {
    name: 'get_payment_details',
    description:
      'Every payment attempt for an order, including failures, retries, refunds, gateway ids and ' +
      'failure codes. Use only when the user asks for payment specifics that the summary does not ' +
      'cover, such as transaction ids or the exact failure reason.',
    parameters: {
      type: 'object',
      properties: {
        order_id: { type: 'string', description: 'Order reference, e.g. 4521 or ORD-4521.' },
      },
      required: ['order_id'],
    },
  },
  {
    name: 'get_delivery_details',
    description:
      'Courier, tracking number, promised date, attempt history and current location for an order. ' +
      'Use for tracking-specific questions. Returns delivery_record: null when nothing is scheduled.',
    parameters: {
      type: 'object',
      properties: {
        order_id: { type: 'string', description: 'Order reference, e.g. 4521 or ORD-4521.' },
      },
      required: ['order_id'],
    },
  },
  {
    name: 'get_order_timeline',
    description:
      'Chronological event log for an order (placed, paid, dispatched, delayed, refunded and so on). ' +
      'Use when the user asks what happened, in what order, or wants a history.',
    parameters: {
      type: 'object',
      properties: {
        order_id: { type: 'string', description: 'Order reference, e.g. 4521 or ORD-4521.' },
      },
      required: ['order_id'],
    },
  },
  {
    name: 'search_orders',
    description:
      'Find orders matching filters when the user has no specific order id - for example ' +
      '"which orders are paid but not shipped" or "show me delayed deliveries". ' +
      'Returns a compact list, not full details.',
    parameters: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          description: 'Order status filter.',
          enum: ['PENDING', 'CONFIRMED', 'PROCESSING', 'SHIPPED', 'DELIVERED', 'CANCELLED', 'RETURNED', 'PAYMENT_FAILED'],
        },
        payment_status: {
          type: 'string',
          description: 'Payment status filter.',
          enum: ['PENDING', 'PAID', 'FAILED', 'REFUNDED', 'PARTIALLY_REFUNDED', 'REFUND_PENDING', 'COD_PENDING'],
        },
        delivery_status: {
          type: 'string',
          description: 'Delivery status filter. Use NONE to find orders with no delivery record at all.',
          enum: ['NONE', 'SCHEDULED', 'AWAITING_PICKUP', 'IN_TRANSIT', 'DELAYED', 'FAILED_ATTEMPT', 'DELIVERED', 'RTO'],
        },
        customer_id: { type: 'string', description: 'Restrict to one customer, e.g. CUST-00012.' },
        limit: { type: 'integer', description: 'Maximum rows to return (default 25, max 50).' },
      },
      required: [],
    },
  },
  {
    name: 'find_customer',
    description:
      'Look up customers by name or email fragment, to resolve "the order from Priya Sharma" into ' +
      'a customer id you can then pass to search_orders.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Partial name or email.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_operational_summary',
    description:
      'Fleet-wide operational health: order and delivery status counts, value at risk, ' +
      'how many orders are paid with nothing scheduled, overdue deliveries and open ticket load. ' +
      'Use for questions about the business overall rather than one order.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
];

/* ------------------------------------------------------------------ *
 * Tool implementations
 * ------------------------------------------------------------------ */
export function createToolRegistry(repo) {
  const now = repo.now();

  const impl = {
    get_order_summary({ order_id }) {
      const g = loadGraph(repo, order_id);
      const { payment_summary, findings } = diagnose({ ...g, now });

      return {
        order_id: g.orderId,
        health: healthFrom(findings),
        order: {
          status: g.order.status,
          payment_status: g.order.payment_status,
          placed_at: g.order.placed_at,
          channel: g.order.channel,
          item_count: g.order.items.length,
          items: g.order.items.map((i) => i.quantity + ' x ' + i.name),
          grand_total: g.order.totals.grand_total,
          grand_total_formatted: inr(g.order.totals.grand_total),
        },
        customer: g.customer && {
          customer_id: g.customer.customer_id,
          name: g.customer.name,
          tier: g.customer.tier,
          city: g.customer.address.city,
        },
        payment: {
          state: payment_summary.state,
          method: payment_summary.method,
          captured: payment_summary.captured,
          amount_paid_formatted: inr(payment_summary.amount_paid),
          amount_refunded_formatted: inr(payment_summary.amount_refunded),
          attempts: payment_summary.attempts,
          failed_attempt_count: payment_summary.failed_attempts.length,
        },
        delivery: g.delivery
          ? {
              status: g.delivery.status,
              courier: g.delivery.courier,
              tracking_number: g.delivery.tracking_number,
              promised_date: g.delivery.promised_date,
              delivered_at: g.delivery.delivered_at,
              attempts: g.delivery.attempts,
              current_location: g.delivery.current_location,
              failure_reason: g.delivery.failure_reason,
            }
          : null,
        delivery_scheduled: Boolean(g.delivery),
        open_tickets: g.tickets
          .filter((t) => t.status === 'OPEN')
          .map((t) => ({ ticket_id: t.ticket_id, subject: t.subject, priority: t.priority })),
        findings,
        as_of: now.toISOString(),
      };
    },

    get_payment_details({ order_id }) {
      const g = loadGraph(repo, order_id);
      const { payment_summary } = diagnose({ ...g, now });
      return {
        order_id: g.orderId,
        summary: {
          state: payment_summary.state,
          captured: payment_summary.captured,
          method: payment_summary.method,
          gateway: payment_summary.gateway,
          amount_paid: payment_summary.amount_paid,
          amount_refunded: payment_summary.amount_refunded,
          net_amount_formatted: inr(payment_summary.net_amount ?? 0),
        },
        order_total_formatted: inr(g.order.totals.grand_total),
        attempts: g.payments.map((p) => ({
          payment_id: p.payment_id,
          status: p.status,
          method: p.method,
          gateway: p.gateway,
          gateway_txn_id: p.gateway_txn_id,
          amount_formatted: inr(p.amount),
          refunded_amount_formatted: inr(p.refunded_amount),
          attempted_at: p.attempted_at,
          completed_at: p.completed_at,
          failure_code: p.failure_code,
          failure_reason: p.failure_reason,
        })),
        as_of: now.toISOString(),
      };
    },

    get_delivery_details({ order_id }) {
      const g = loadGraph(repo, order_id);
      if (!g.delivery) {
        return {
          order_id: g.orderId,
          delivery_record: null,
          note:
            'No delivery has been scheduled for this order. Order status is ' + g.order.status +
            ' and payment status is ' + g.order.payment_status + '.',
          as_of: now.toISOString(),
        };
      }
      const promised = new Date(g.delivery.promised_date);
      const overdue = !['DELIVERED', 'RTO'].includes(g.delivery.status) && promised < now;
      return {
        order_id: g.orderId,
        delivery_record: {
          ...g.delivery,
          is_overdue: overdue,
          days_overdue: overdue ? Math.floor((now - promised) / 86400000) : 0,
        },
        shipping_address: g.order.shipping_address,
        as_of: now.toISOString(),
      };
    },

    get_order_timeline({ order_id }) {
      const g = loadGraph(repo, order_id);
      return {
        order_id: g.orderId,
        event_count: g.events.length,
        timeline: g.events.map((e) => ({
          at: e.at,
          type: e.type,
          description: e.description,
          source: e.source,
        })),
        tickets: g.tickets.map((t) => ({
          ticket_id: t.ticket_id,
          created_at: t.created_at,
          subject: t.subject,
          priority: t.priority,
          status: t.status,
        })),
        as_of: now.toISOString(),
      };
    },

    search_orders(args = {}) {
      const limit = Math.min(Math.max(Number(args.limit) || 25, 1), 50);
      const rows = repo.findOrders({
        status: args.status,
        paymentStatus: args.payment_status,
        deliveryStatus: args.delivery_status,
        customerId: args.customer_id,
        limit,
      });

      return {
        filters_applied: {
          status: args.status ?? null,
          payment_status: args.payment_status ?? null,
          delivery_status: args.delivery_status ?? null,
          customer_id: args.customer_id ?? null,
        },
        result_count: rows.length,
        truncated: rows.length === limit,
        orders: rows.map((o) => {
          const dl = repo.getDelivery(o.order_id);
          return {
            order_id: o.order_id,
            status: o.status,
            payment_status: o.payment_status,
            delivery_status: dl ? dl.status : 'NONE',
            placed_at: o.placed_at,
            grand_total_formatted: inr(o.totals.grand_total),
          };
        }),
        as_of: now.toISOString(),
      };
    },

    find_customer({ query }) {
      if (!query || !String(query).trim()) {
        throw new ToolError('INVALID_QUERY', 'A non-empty name or email fragment is required.');
      }
      const matches = repo.findCustomersByName(query);
      return {
        query,
        result_count: matches.length,
        customers: matches.map((c) => ({
          customer_id: c.customer_id,
          name: c.name,
          email: c.email,
          tier: c.tier,
          city: c.address.city,
        })),
      };
    },

    get_operational_summary() {
      return repo.aggregates();
    },
  };

  /**
   * Executes a tool by name with model-supplied arguments. Errors are
   * converted into structured results rather than thrown, so a bad call
   * becomes something the model can read and recover from on the next turn.
   */
  async function execute(name, args = {}) {
    const fn = impl[name];
    if (!fn) {
      return { ok: false, error: { code: 'UNKNOWN_TOOL', message: 'No tool named "' + name + '".' } };
    }
    try {
      const data = await fn(args ?? {});
      return { ok: true, data };
    } catch (err) {
      if (err instanceof ToolError) {
        return { ok: false, error: { code: err.code, message: err.message, details: err.details } };
      }
      return { ok: false, error: { code: 'TOOL_EXECUTION_ERROR', message: err.message } };
    }
  }

  return { declarations: TOOL_DECLARATIONS, execute, impl };
}

export default createToolRegistry;
