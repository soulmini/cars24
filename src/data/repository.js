/**
 * Data access layer.
 *
 * The copilot's tools talk to this interface, never to the raw JSON. Every
 * method here is the shape a real SQL query would take, so swapping the
 * JsonRepository for a Postgres-backed one is a drop-in change that needs no
 * edits in src/tools or src/agent.
 *
 * Indexes are built once at load time. Order lookup is the hot path (every
 * tool call starts with one), so it must be O(1), not a linear scan.
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_SEED_PATH = resolve(__dirname, '..', '..', 'data', 'seed.json');

/**
 * Normalises anything a user might type into a canonical order id.
 *
 * Ops staff and customers write order references half a dozen ways:
 * "#4521", "4521", "ord-4521", "Order ORD-4521". They all mean one row.
 */
export function normalizeOrderId(input) {
  if (input === null || input === undefined) return null;
  const raw = String(input).trim();
  if (!raw) return null;

  const digits = raw.match(/(\d{3,})/);
  if (!digits) return null;
  return 'ORD-' + digits[1];
}

function groupBy(rows, key) {
  const map = new Map();
  for (const row of rows) {
    const k = row[key];
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(row);
  }
  return map;
}

export class JsonRepository {
  #data;
  #ordersById = new Map();
  #customersById = new Map();
  #paymentsByOrder = new Map();
  #deliveryByOrder = new Map();
  #ticketsByOrder = new Map();
  #eventsByOrder = new Map();

  constructor(dataset) {
    this.#data = dataset;
    this.#buildIndexes();
  }

  static fromFile(path = DEFAULT_SEED_PATH) {
    let raw;
    try {
      raw = readFileSync(path, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') {
        throw new Error(
          'Seed data not found at ' + path + '. Run `npm run seed` first.',
        );
      }
      throw err;
    }
    return new JsonRepository(JSON.parse(raw));
  }

  #buildIndexes() {
    const d = this.#data;
    for (const o of d.orders) this.#ordersById.set(o.order_id, o);
    for (const c of d.customers) this.#customersById.set(c.customer_id, c);
    this.#paymentsByOrder = groupBy(d.payments, 'order_id');
    for (const dl of d.deliveries) this.#deliveryByOrder.set(dl.order_id, dl);
    this.#ticketsByOrder = groupBy(d.tickets, 'order_id');
    this.#eventsByOrder = groupBy(d.events, 'order_id');
  }

  get meta() {
    return this.#data.meta;
  }

  /**
   * The dataset's frozen "now". Every relative-time calculation in the tools
   * goes through this rather than Date.now(), so a fixture generated once
   * keeps producing the same "3 days overdue" answer forever.
   */
  now() {
    return new Date(this.#data.meta.generated_at);
  }

  getOrder(orderId) {
    return this.#ordersById.get(orderId) ?? null;
  }

  getCustomer(customerId) {
    return this.#customersById.get(customerId) ?? null;
  }

  getPayments(orderId) {
    const rows = this.#paymentsByOrder.get(orderId) ?? [];
    return [...rows].sort((a, b) => new Date(a.attempted_at) - new Date(b.attempted_at));
  }

  getDelivery(orderId) {
    return this.#deliveryByOrder.get(orderId) ?? null;
  }

  getTickets(orderId) {
    const rows = this.#ticketsByOrder.get(orderId) ?? [];
    return [...rows].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  }

  getEvents(orderId) {
    const rows = this.#eventsByOrder.get(orderId) ?? [];
    return [...rows].sort((a, b) => new Date(a.at) - new Date(b.at));
  }

  /**
   * Filtered order search. Mirrors a parameterised WHERE clause; each filter
   * is optional and they AND together.
   */
  findOrders({ status, paymentStatus, deliveryStatus, customerId, placedAfter, placedBefore, limit = 25 } = {}) {
    let rows = this.#data.orders;

    if (status) rows = rows.filter((o) => o.status === status);
    if (paymentStatus) rows = rows.filter((o) => o.payment_status === paymentStatus);
    if (customerId) rows = rows.filter((o) => o.customer_id === customerId);
    if (placedAfter) {
      const t = new Date(placedAfter);
      rows = rows.filter((o) => new Date(o.placed_at) >= t);
    }
    if (placedBefore) {
      const t = new Date(placedBefore);
      rows = rows.filter((o) => new Date(o.placed_at) <= t);
    }
    if (deliveryStatus) {
      rows = rows.filter((o) => {
        const dl = this.#deliveryByOrder.get(o.order_id);
        if (deliveryStatus === 'NONE') return !dl;
        return dl?.status === deliveryStatus;
      });
    }

    return [...rows]
      .sort((a, b) => new Date(b.placed_at) - new Date(a.placed_at))
      .slice(0, limit);
  }

  findCustomersByName(query, limit = 10) {
    const q = String(query).toLowerCase().trim();
    if (!q) return [];
    return this.#data.customers
      .filter((c) => c.name.toLowerCase().includes(q) || c.email.toLowerCase().includes(q))
      .slice(0, limit);
  }

  /**
   * Fleet-wide counters used by the operational-summary tool. Computed on
   * demand; the dataset is small enough that caching would be premature.
   */
  aggregates() {
    const now = this.now();
    const orders = this.#data.orders;

    const byStatus = {};
    const byPaymentStatus = {};
    for (const o of orders) {
      byStatus[o.status] = (byStatus[o.status] ?? 0) + 1;
      byPaymentStatus[o.payment_status] = (byPaymentStatus[o.payment_status] ?? 0) + 1;
    }

    const byDeliveryStatus = {};
    for (const dl of this.#data.deliveries) {
      byDeliveryStatus[dl.status] = (byDeliveryStatus[dl.status] ?? 0) + 1;
    }
    byDeliveryStatus.NONE = orders.length - this.#data.deliveries.length;

    const paidNoDelivery = orders.filter(
      (o) => o.payment_status === 'PAID' && !this.#deliveryByOrder.has(o.order_id),
    );

    const overdue = this.#data.deliveries.filter((dl) => {
      if (['DELIVERED', 'RTO'].includes(dl.status)) return false;
      return new Date(dl.promised_date) < now;
    });

    const openTickets = this.#data.tickets.filter((t) => t.status === 'OPEN');

    const capturedValue = this.#data.payments
      .filter((p) => ['CAPTURED', 'PARTIALLY_REFUNDED'].includes(p.status))
      .reduce((s, p) => s + p.amount - p.refunded_amount, 0);

    const stuckValue = paidNoDelivery.reduce((s, o) => s + o.totals.grand_total, 0);

    return {
      as_of: now.toISOString(),
      totals: {
        orders: orders.length,
        customers: this.#data.customers.length,
        open_tickets: openTickets.length,
        net_captured_value_inr: capturedValue,
      },
      orders_by_status: byStatus,
      orders_by_payment_status: byPaymentStatus,
      deliveries_by_status: byDeliveryStatus,
      risk: {
        paid_without_delivery_count: paidNoDelivery.length,
        paid_without_delivery_value_inr: stuckValue,
        paid_without_delivery_orders: paidNoDelivery.slice(0, 10).map((o) => o.order_id),
        overdue_delivery_count: overdue.length,
        overdue_delivery_orders: overdue.slice(0, 10).map((d) => d.order_id),
        high_priority_open_tickets: openTickets.filter((t) => t.priority === 'HIGH').length,
      },
    };
  }
}

export default JsonRepository;
