#!/usr/bin/env node
/**
 * Deterministic seed generator for the AI Operations Copilot.
 *
 * Produces `data/seed.json`: a realistic snapshot of an e-commerce operations
 * backend (orders, payments, deliveries, support tickets, event timeline).
 *
 * Determinism matters here. The evaluation suite asserts against specific
 * order IDs, so the generator uses a seeded PRNG rather than Math.random().
 * Re-running produces byte-identical output.
 *
 *   npm run seed
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = resolve(__dirname, '..', 'data', 'seed.json');

/* ------------------------------------------------------------------ *
 * Seeded PRNG (mulberry32) - deterministic across runs and platforms.
 * ------------------------------------------------------------------ */
function mulberry32(seed) {
  return function rng() {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = mulberry32(20240517);
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const randInt = (min, max) => Math.floor(rand() * (max - min + 1)) + min;

/* ------------------------------------------------------------------ *
 * Reference data
 * ------------------------------------------------------------------ */
const FIRST_NAMES = [
  'Aarav', 'Priya', 'Rohan', 'Sneha', 'Vikram', 'Ananya', 'Karthik', 'Meera',
  'Arjun', 'Divya', 'Rahul', 'Ishita', 'Siddharth', 'Nisha', 'Aditya', 'Kavya',
  'Manish', 'Pooja', 'Rajesh', 'Tanvi', 'Gaurav', 'Shreya', 'Nikhil', 'Lakshmi',
];
const LAST_NAMES = [
  'Sharma', 'Patel', 'Reddy', 'Nair', 'Iyer', 'Gupta', 'Singh', 'Menon',
  'Desai', 'Rao', 'Joshi', 'Kulkarni', 'Verma', 'Bose', 'Chopra', 'Malhotra',
];
const CITIES = [
  { city: 'Bengaluru', state: 'Karnataka', pincode: '560001' },
  { city: 'Mumbai', state: 'Maharashtra', pincode: '400001' },
  { city: 'Delhi', state: 'Delhi', pincode: '110001' },
  { city: 'Hyderabad', state: 'Telangana', pincode: '500001' },
  { city: 'Chennai', state: 'Tamil Nadu', pincode: '600001' },
  { city: 'Pune', state: 'Maharashtra', pincode: '411001' },
  { city: 'Kolkata', state: 'West Bengal', pincode: '700001' },
  { city: 'Ahmedabad', state: 'Gujarat', pincode: '380001' },
];
const PRODUCTS = [
  { sku: 'ELEC-TV-55U', name: '55-inch 4K Ultra HD Smart TV', price: 48999, category: 'Electronics', weightKg: 18.5 },
  { sku: 'ELEC-LAP-14P', name: '14-inch Pro Laptop 16GB/512GB', price: 89999, category: 'Electronics', weightKg: 1.4 },
  { sku: 'ELEC-HP-ANC', name: 'Noise Cancelling Headphones', price: 24999, category: 'Electronics', weightKg: 0.3 },
  { sku: 'APPL-WM-7KG', name: '7kg Front Load Washing Machine', price: 32499, category: 'Appliances', weightKg: 62.0 },
  { sku: 'APPL-RF-260', name: '260L Double Door Refrigerator', price: 27999, category: 'Appliances', weightKg: 55.0 },
  { sku: 'APPL-MW-28L', name: '28L Convection Microwave', price: 12499, category: 'Appliances', weightKg: 16.0 },
  { sku: 'FURN-SOFA-3S', name: '3-Seater Fabric Sofa', price: 34999, category: 'Furniture', weightKg: 45.0 },
  { sku: 'FURN-BED-QN', name: 'Queen Bed with Storage', price: 41999, category: 'Furniture', weightKg: 78.0 },
  { sku: 'MOBL-SM-256', name: 'Smartphone 256GB 5G', price: 54999, category: 'Mobiles', weightKg: 0.22 },
  { sku: 'MOBL-TB-11', name: '11-inch Tablet Wi-Fi 128GB', price: 31999, category: 'Mobiles', weightKg: 0.48 },
  { sku: 'HOME-AP-HEPA', name: 'HEPA Air Purifier', price: 15999, category: 'Home', weightKg: 7.2 },
  { sku: 'HOME-VC-ROBO', name: 'Robotic Vacuum Cleaner', price: 28999, category: 'Home', weightKg: 3.6 },
];
const COURIERS = ['BlueDart', 'Delhivery', 'Ekart', 'XpressBees', 'Safexpress'];
const PAYMENT_METHODS = ['UPI', 'CREDIT_CARD', 'DEBIT_CARD', 'NET_BANKING', 'COD', 'WALLET'];
const GATEWAYS = ['Razorpay', 'PayU', 'Cashfree'];

/* Anchor "now" so generated timelines are stable and reproducible. */
const NOW = new Date('2024-05-17T10:30:00.000Z');
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

const iso = (d) => new Date(d).toISOString();
const addDays = (d, n) => new Date(new Date(d).getTime() + n * DAY);
const addHours = (d, n) => new Date(new Date(d).getTime() + n * HOUR);

function formatINR(amount) {
  return 'INR ' + Number(amount).toLocaleString('en-IN');
}

/* ------------------------------------------------------------------ *
 * Scenario matrix
 *
 * Each order is assigned a scenario so the dataset deliberately contains the
 * operational edge cases an ops copilot must reason about, rather than a
 * uniform blob of happy-path rows.
 * ------------------------------------------------------------------ */
const SCENARIOS = [
  { key: 'HAPPY_DELIVERED', weight: 22 },
  { key: 'IN_TRANSIT', weight: 14 },
  { key: 'PAID_NOT_SCHEDULED', weight: 10 }, // the "paid but no delivery" case
  { key: 'PAYMENT_PENDING', weight: 8 },
  { key: 'PAYMENT_FAILED_RETRY', weight: 8 },
  { key: 'DELIVERY_DELAYED', weight: 10 },
  { key: 'DELIVERY_FAILED', weight: 6 },
  { key: 'RTO', weight: 4 },
  { key: 'CANCELLED_REFUNDED', weight: 6 },
  { key: 'PARTIAL_REFUND', weight: 4 },
  { key: 'COD_PENDING', weight: 5 },
  { key: 'AWAITING_PICKUP', weight: 3 },
];

function weightedScenario() {
  const total = SCENARIOS.reduce((s, x) => s + x.weight, 0);
  let roll = rand() * total;
  for (const s of SCENARIOS) {
    roll -= s.weight;
    if (roll <= 0) return s.key;
  }
  return SCENARIOS[0].key;
}

/* Orders that must exist verbatim because the problem statement names them. */
const PINNED = {
  4521: 'HAPPY_DELIVERED',
  1289: 'PAID_NOT_SCHEDULED',
  2231: 'DELIVERY_DELAYED',
};

/* ------------------------------------------------------------------ *
 * Generators
 * ------------------------------------------------------------------ */
function makeCustomer(id) {
  const first = pick(FIRST_NAMES);
  const last = pick(LAST_NAMES);
  const loc = pick(CITIES);
  return {
    customer_id: 'CUST-' + String(id).padStart(5, '0'),
    name: first + ' ' + last,
    email: first.toLowerCase() + '.' + last.toLowerCase() + randInt(1, 99) + '@example.com',
    phone: '+91' + randInt(70000, 99999) + randInt(10000, 99999),
    address: {
      line1: randInt(1, 400) + ', ' + pick(['MG Road', 'Park Street', 'Ring Road', '4th Cross', 'Sector 12', 'Church Street']),
      city: loc.city,
      state: loc.state,
      pincode: loc.pincode,
      country: 'India',
    },
    tier: pick(['STANDARD', 'STANDARD', 'STANDARD', 'PLUS', 'PREMIUM']),
    created_at: iso(addDays(NOW, -randInt(30, 900))),
  };
}

function makeLineItems() {
  const count = randInt(1, 3);
  const chosen = [];
  const seen = new Set();
  while (chosen.length < count) {
    const p = pick(PRODUCTS);
    if (seen.has(p.sku)) continue;
    seen.add(p.sku);
    const qty = randInt(1, 2);
    chosen.push({
      sku: p.sku,
      name: p.name,
      category: p.category,
      quantity: qty,
      unit_price: p.price,
      line_total: p.price * qty,
      weight_kg: +(p.weightKg * qty).toFixed(2),
    });
  }
  return chosen;
}

/**
 * Builds one fully-consistent order graph: the order row, its payment
 * attempts, its delivery record, any support tickets and a merged event
 * timeline. Consistency across these tables is the point - the copilot's
 * whole job is spotting when payment state and delivery state disagree.
 */
function buildOrder(orderNum, customer, scenario) {
  const orderId = 'ORD-' + orderNum;
  const items = makeLineItems();
  const subtotal = items.reduce((s, i) => s + i.line_total, 0);
  const shippingFee = subtotal > 50000 ? 0 : (randInt(0, 1) ? 499 : 299);
  const discount = rand() < 0.35 ? Math.round(subtotal * (randInt(3, 12) / 100)) : 0;
  const taxable = subtotal - discount;
  const tax = Math.round(taxable * 0.18);
  const total = taxable + tax + shippingFee;

  const placedAt = addDays(NOW, -randInt(1, 28));
  const method = scenario === 'COD_PENDING'
    ? 'COD'
    : pick(PAYMENT_METHODS.filter((m) => m !== 'COD'));
  const gateway = method === 'COD' ? null : pick(GATEWAYS);

  const events = [];
  const payments = [];
  const tickets = [];
  let delivery = null;
  let orderStatus = 'PENDING';
  let paymentStatus = 'PENDING';

  const addEvent = (at, type, description, source = 'system') => {
    events.push({ at: iso(at), type, description, source });
  };

  addEvent(placedAt, 'ORDER_PLACED',
    'Order ' + orderId + ' placed by ' + customer.name + ' for ' + formatINR(total) + '.');

  let paymentSeq = 1;
  const newPayment = (at, status, extra = {}) => {
    const p = {
      payment_id: 'PAY-' + orderNum + '-' + (paymentSeq++),
      order_id: orderId,
      method,
      gateway,
      gateway_txn_id: gateway
        ? gateway.toUpperCase().slice(0, 3) + '_' + randInt(100000000, 999999999)
        : null,
      amount: total,
      currency: 'INR',
      status,
      attempted_at: iso(at),
      completed_at: status === 'CAPTURED' ? iso(at) : null,
      failure_code: null,
      failure_reason: null,
      refunded_amount: 0,
      ...extra,
    };
    payments.push(p);
    return p;
  };

  const scheduleDelivery = (promisedAt, extra = {}) => {
    delivery = {
      delivery_id: 'DLV-' + orderNum,
      order_id: orderId,
      status: 'SCHEDULED',
      courier: pick(COURIERS),
      tracking_number: String(randInt(100000000000, 999999999999)),
      scheduled_at: iso(promisedAt),
      promised_date: iso(promisedAt),
      dispatched_at: null,
      delivered_at: null,
      attempts: 0,
      last_attempt_at: null,
      failure_reason: null,
      current_location: null,
      ...extra,
    };
    return delivery;
  };

  const openTicket = (at, subject, body, priority, status = 'OPEN') => {
    const t = {
      ticket_id: 'TKT-' + orderNum + '-' + (tickets.length + 1),
      order_id: orderId,
      customer_id: customer.customer_id,
      subject,
      body,
      channel: pick(['EMAIL', 'PHONE', 'CHAT', 'APP']),
      priority,
      status,
      created_at: iso(at),
      updated_at: iso(at),
      resolved_at: status === 'RESOLVED' ? iso(addHours(at, randInt(2, 48))) : null,
      assigned_to: pick(['ops.team1', 'ops.team2', 'escalations', null]),
    };
    tickets.push(t);
    return t;
  };

  /* --- scenario branches ------------------------------------------ */
  switch (scenario) {
    case 'HAPPY_DELIVERED': {
      const paidAt = addHours(placedAt, randInt(0, 2));
      newPayment(paidAt, 'CAPTURED');
      paymentStatus = 'PAID';
      addEvent(paidAt, 'PAYMENT_CAPTURED',
        'Payment of ' + formatINR(total) + ' captured via ' + method + '.');

      const promised = addDays(placedAt, randInt(3, 6));
      const dispatchedAt = addDays(paidAt, 1);
      const deliveredAt = addHours(promised, -randInt(2, 20));
      scheduleDelivery(promised, {
        status: 'DELIVERED',
        dispatched_at: iso(dispatchedAt),
        delivered_at: iso(deliveredAt),
        attempts: 1,
        last_attempt_at: iso(deliveredAt),
        current_location: customer.address.city,
      });
      addEvent(dispatchedAt, 'DISPATCHED',
        'Shipment handed to ' + delivery.courier + ', AWB ' + delivery.tracking_number + '.');
      addEvent(deliveredAt, 'DELIVERED',
        'Delivered to ' + customer.address.city + ', signed by customer.');
      orderStatus = 'DELIVERED';
      break;
    }

    case 'IN_TRANSIT': {
      const paidAt = addHours(placedAt, randInt(0, 3));
      newPayment(paidAt, 'CAPTURED');
      paymentStatus = 'PAID';
      addEvent(paidAt, 'PAYMENT_CAPTURED',
        'Payment of ' + formatINR(total) + ' captured via ' + method + '.');

      const promised = addDays(NOW, randInt(1, 4));
      const dispatchedAt = addDays(paidAt, 1);
      scheduleDelivery(promised, {
        status: 'IN_TRANSIT',
        dispatched_at: iso(dispatchedAt),
        current_location: pick(CITIES).city + ' hub',
      });
      addEvent(dispatchedAt, 'DISPATCHED',
        'Shipment handed to ' + delivery.courier + ', AWB ' + delivery.tracking_number + '.');
      addEvent(addHours(dispatchedAt, 8), 'IN_TRANSIT',
        'Package scanned at ' + delivery.current_location + '.');
      orderStatus = 'SHIPPED';
      break;
    }

    case 'PAID_NOT_SCHEDULED': {
      // The headline failure mode: money captured, nothing scheduled.
      const paidAt = addHours(placedAt, randInt(0, 2));
      newPayment(paidAt, 'CAPTURED');
      paymentStatus = 'PAID';
      addEvent(paidAt, 'PAYMENT_CAPTURED',
        'Payment of ' + formatINR(total) + ' captured via ' + method + '.');
      addEvent(addHours(paidAt, 1), 'WAREHOUSE_HOLD',
        'Fulfilment blocked: ' + pick([
          'inventory allocation failed for one or more SKUs',
          'address pincode not serviceable by assigned courier',
          'warehouse capacity exceeded for oversized item',
          'risk review flagged order for manual verification',
        ]) + '.', 'warehouse');
      delivery = null; // deliberately absent
      orderStatus = 'PROCESSING';

      const daysStuck = Math.round((NOW - paidAt) / DAY);
      if (daysStuck >= 2) {
        openTicket(addDays(paidAt, 2),
          'Paid but no delivery date',
          'Customer states payment was debited on ' + iso(paidAt).slice(0, 10) +
            ' but the app shows no scheduled delivery.',
          daysStuck >= 5 ? 'HIGH' : 'MEDIUM');
      }
      break;
    }

    case 'PAYMENT_PENDING': {
      newPayment(placedAt, 'PENDING');
      paymentStatus = 'PENDING';
      addEvent(placedAt, 'PAYMENT_INITIATED',
        'Payment of ' + formatINR(total) + ' initiated via ' + method + '; awaiting gateway confirmation.');
      orderStatus = 'PENDING';
      break;
    }

    case 'PAYMENT_FAILED_RETRY': {
      const failAt = placedAt;
      const failure = pick([
        { code: 'INSUFFICIENT_FUNDS', reason: 'Issuing bank declined: insufficient funds.' },
        { code: 'AUTH_TIMEOUT', reason: '3-D Secure authentication timed out.' },
        { code: 'CARD_DECLINED', reason: 'Card declined by issuer.' },
        { code: 'UPI_COLLECT_EXPIRED', reason: 'UPI collect request expired without approval.' },
      ]);
      newPayment(failAt, 'FAILED', { failure_code: failure.code, failure_reason: failure.reason });
      addEvent(failAt, 'PAYMENT_FAILED', 'Payment attempt failed - ' + failure.reason);

      // ~60% of failures are retried successfully.
      if (rand() < 0.6) {
        const retryAt = addHours(failAt, randInt(1, 10));
        newPayment(retryAt, 'CAPTURED');
        paymentStatus = 'PAID';
        addEvent(retryAt, 'PAYMENT_CAPTURED',
          'Retry succeeded; ' + formatINR(total) + ' captured via ' + method + '.');
        const promised = addDays(retryAt, randInt(3, 6));
        scheduleDelivery(promised);
        addEvent(addHours(retryAt, 2), 'DELIVERY_SCHEDULED',
          'Delivery scheduled for ' + iso(promised).slice(0, 10) + '.');
        orderStatus = 'CONFIRMED';
      } else {
        paymentStatus = 'FAILED';
        orderStatus = 'PAYMENT_FAILED';
        openTicket(addHours(failAt, 3), 'Payment failed but amount debited',
          'Customer reports the amount was debited from their account despite the failure message.',
          'HIGH');
      }
      break;
    }

    case 'DELIVERY_DELAYED': {
      const paidAt = addHours(placedAt, randInt(0, 2));
      newPayment(paidAt, 'CAPTURED');
      paymentStatus = 'PAID';
      addEvent(paidAt, 'PAYMENT_CAPTURED',
        'Payment of ' + formatINR(total) + ' captured via ' + method + '.');

      const promised = addDays(placedAt, randInt(3, 5)); // already in the past
      const dispatchedAt = addDays(paidAt, 1);
      const reason = pick([
        'Courier hub congestion at origin facility',
        'Regional weather disruption',
        'Vehicle breakdown in transit',
        'Incorrect pincode routing, package rerouted',
      ]);
      scheduleDelivery(promised, {
        status: 'DELAYED',
        dispatched_at: iso(dispatchedAt),
        current_location: pick(CITIES).city + ' hub',
        failure_reason: reason,
      });
      addEvent(dispatchedAt, 'DISPATCHED',
        'Shipment handed to ' + delivery.courier + ', AWB ' + delivery.tracking_number + '.');
      addEvent(promised, 'DELIVERY_DELAYED',
        'Missed promised date. Reason: ' + reason + '.', 'courier');
      orderStatus = 'SHIPPED';
      openTicket(addHours(promised, 6), 'Where is my order?',
        'Promised delivery on ' + iso(promised).slice(0, 10) +
          ' was missed. Customer requesting a revised ETA.',
        'MEDIUM');
      break;
    }

    case 'DELIVERY_FAILED': {
      const paidAt = addHours(placedAt, randInt(0, 2));
      newPayment(paidAt, 'CAPTURED');
      paymentStatus = 'PAID';
      addEvent(paidAt, 'PAYMENT_CAPTURED',
        'Payment of ' + formatINR(total) + ' captured via ' + method + '.');

      const promised = addDays(placedAt, randInt(3, 5));
      const dispatchedAt = addDays(paidAt, 1);
      const attempts = randInt(1, 3);
      const lastAttempt = addHours(promised, randInt(2, 30));
      const reason = pick([
        'Customer unavailable at address',
        'Address incomplete - landmark missing',
        'Customer requested reschedule',
        'Entry denied at gated community',
      ]);
      scheduleDelivery(promised, {
        status: 'FAILED_ATTEMPT',
        dispatched_at: iso(dispatchedAt),
        attempts,
        last_attempt_at: iso(lastAttempt),
        failure_reason: reason,
        current_location: customer.address.city + ' local facility',
      });
      addEvent(dispatchedAt, 'DISPATCHED',
        'Shipment handed to ' + delivery.courier + ', AWB ' + delivery.tracking_number + '.');
      addEvent(lastAttempt, 'DELIVERY_ATTEMPT_FAILED',
        'Attempt ' + attempts + ' of 3 failed. Reason: ' + reason + '.', 'courier');
      orderStatus = 'SHIPPED';
      openTicket(addHours(lastAttempt, 2), 'Delivery attempt failed',
        'Courier reported "' + reason + '". Customer disputes this and wants redelivery.', 'HIGH');
      break;
    }

    case 'RTO': {
      const paidAt = addHours(placedAt, randInt(0, 2));
      newPayment(paidAt, 'CAPTURED');
      addEvent(paidAt, 'PAYMENT_CAPTURED',
        'Payment of ' + formatINR(total) + ' captured via ' + method + '.');
      const promised = addDays(placedAt, randInt(3, 5));
      const dispatchedAt = addDays(paidAt, 1);
      const rtoAt = addDays(promised, randInt(2, 5));
      scheduleDelivery(promised, {
        status: 'RTO',
        dispatched_at: iso(dispatchedAt),
        attempts: 3,
        last_attempt_at: iso(addDays(promised, 1)),
        failure_reason: 'Three delivery attempts exhausted',
        current_location: 'Returning to origin warehouse',
      });
      addEvent(dispatchedAt, 'DISPATCHED',
        'Shipment handed to ' + delivery.courier + ', AWB ' + delivery.tracking_number + '.');
      addEvent(rtoAt, 'RTO_INITIATED', 'Return to origin initiated after 3 failed attempts.', 'courier');

      const refundAt = addDays(rtoAt, 2);
      payments[0].status = 'REFUNDED';
      payments[0].refunded_amount = total;
      paymentStatus = 'REFUNDED';
      addEvent(refundAt, 'REFUND_INITIATED',
        'Full refund of ' + formatINR(total) + ' initiated to original payment method.');
      orderStatus = 'RETURNED';
      break;
    }

    case 'CANCELLED_REFUNDED': {
      const paidAt = addHours(placedAt, randInt(0, 2));
      newPayment(paidAt, 'CAPTURED');
      addEvent(paidAt, 'PAYMENT_CAPTURED',
        'Payment of ' + formatINR(total) + ' captured via ' + method + '.');
      const cancelledAt = addDays(paidAt, randInt(1, 4));
      const who = pick(['customer', 'ops']);
      addEvent(cancelledAt, 'ORDER_CANCELLED',
        'Order cancelled by ' + who + '. Reason: ' +
          pick(['changed mind', 'found better price', 'item out of stock', 'delivery too slow']) + '.',
        who);
      const refundAt = addHours(cancelledAt, randInt(2, 72));
      const settled = rand() < 0.7;
      payments[0].status = settled ? 'REFUNDED' : 'REFUND_PENDING';
      payments[0].refunded_amount = settled ? total : 0;
      paymentStatus = settled ? 'REFUNDED' : 'REFUND_PENDING';
      addEvent(refundAt, settled ? 'REFUND_COMPLETED' : 'REFUND_INITIATED',
        'Refund of ' + formatINR(total) + ' ' +
          (settled ? 'settled to source account' : 'initiated; 5-7 business days to settle') + '.');
      orderStatus = 'CANCELLED';
      if (!settled) {
        openTicket(addDays(refundAt, 6), 'Refund not received',
          'Customer says the refund has not reflected in their account after a week.', 'HIGH');
      }
      break;
    }

    case 'PARTIAL_REFUND': {
      const paidAt = addHours(placedAt, randInt(0, 2));
      newPayment(paidAt, 'CAPTURED');
      addEvent(paidAt, 'PAYMENT_CAPTURED',
        'Payment of ' + formatINR(total) + ' captured via ' + method + '.');
      const promised = addDays(placedAt, randInt(3, 5));
      const deliveredAt = addHours(promised, -randInt(1, 12));
      scheduleDelivery(promised, {
        status: 'DELIVERED',
        dispatched_at: iso(addDays(paidAt, 1)),
        delivered_at: iso(deliveredAt),
        attempts: 1,
        last_attempt_at: iso(deliveredAt),
        current_location: customer.address.city,
      });
      addEvent(deliveredAt, 'DELIVERED', 'Delivered to ' + customer.address.city + '.');
      const damagedItem = items[0];
      const refundAmount = Math.round(damagedItem.line_total * 0.5);
      const claimAt = addHours(deliveredAt, randInt(4, 48));
      openTicket(claimAt, 'Item damaged on arrival',
        damagedItem.name + ' arrived with visible damage. Customer requesting partial refund or replacement.',
        'HIGH', 'RESOLVED');
      payments[0].status = 'PARTIALLY_REFUNDED';
      payments[0].refunded_amount = refundAmount;
      paymentStatus = 'PARTIALLY_REFUNDED';
      addEvent(addHours(claimAt, 24), 'PARTIAL_REFUND_ISSUED',
        'Partial refund of ' + formatINR(refundAmount) + ' issued for damaged ' + damagedItem.name + '.', 'ops');
      orderStatus = 'DELIVERED';
      break;
    }

    case 'COD_PENDING': {
      newPayment(placedAt, 'PENDING');
      paymentStatus = 'COD_PENDING';
      const promised = addDays(placedAt, randInt(3, 6));
      const isPast = promised < NOW;
      scheduleDelivery(promised, {
        status: isPast ? 'IN_TRANSIT' : 'SCHEDULED',
        dispatched_at: iso(addDays(placedAt, 1)),
        current_location: isPast ? pick(CITIES).city + ' hub' : null,
      });
      addEvent(addDays(placedAt, 1), 'DISPATCHED',
        'COD shipment handed to ' + delivery.courier + ', AWB ' + delivery.tracking_number + '.');
      addEvent(addHours(placedAt, 1), 'DELIVERY_SCHEDULED',
        'Delivery scheduled for ' + iso(promised).slice(0, 10) + '. Collect ' + formatINR(total) + ' on delivery.');
      orderStatus = 'SHIPPED';
      break;
    }

    case 'AWAITING_PICKUP':
    default: {
      const paidAt = addHours(placedAt, randInt(0, 2));
      newPayment(paidAt, 'CAPTURED');
      paymentStatus = 'PAID';
      addEvent(paidAt, 'PAYMENT_CAPTURED',
        'Payment of ' + formatINR(total) + ' captured via ' + method + '.');
      const promised = addDays(NOW, randInt(2, 6));
      scheduleDelivery(promised, { status: 'AWAITING_PICKUP' });
      addEvent(addHours(paidAt, 3), 'DELIVERY_SCHEDULED',
        'Delivery scheduled for ' + iso(promised).slice(0, 10) + '; awaiting courier pickup.');
      orderStatus = 'CONFIRMED';
      break;
    }
  }

  events.sort((a, b) => new Date(a.at) - new Date(b.at));

  return {
    order: {
      order_id: orderId,
      order_number: orderNum,
      customer_id: customer.customer_id,
      status: orderStatus,
      payment_status: paymentStatus,
      placed_at: iso(placedAt),
      channel: pick(['WEB', 'APP', 'APP', 'MARKETPLACE']),
      items,
      totals: {
        subtotal,
        discount,
        tax,
        shipping_fee: shippingFee,
        grand_total: total,
        currency: 'INR',
      },
      shipping_address: customer.address,
      scenario, // retained for test assertions and evaluation
    },
    payments,
    delivery,
    tickets,
    events: events.map((e, i) => ({ event_id: 'EVT-' + orderNum + '-' + (i + 1), order_id: orderId, ...e })),
  };
}

/* ------------------------------------------------------------------ *
 * Assemble the dataset
 * ------------------------------------------------------------------ */
function generate() {
  const customers = [];
  const orders = [];
  const payments = [];
  const deliveries = [];
  const tickets = [];
  const events = [];

  const ORDER_COUNT = 120;
  const CUSTOMER_COUNT = 60;

  for (let i = 1; i <= CUSTOMER_COUNT; i++) customers.push(makeCustomer(i));

  // Order numbers span 1000-4999 so the pinned IDs sit naturally in range.
  const orderNumbers = new Set(Object.keys(PINNED).map(Number));
  while (orderNumbers.size < ORDER_COUNT) orderNumbers.add(randInt(1000, 4999));

  for (const num of [...orderNumbers].sort((a, b) => a - b)) {
    const customer = customers[randInt(0, customers.length - 1)];
    const scenario = PINNED[num] ?? weightedScenario();
    const built = buildOrder(num, customer, scenario);
    orders.push(built.order);
    payments.push(...built.payments);
    if (built.delivery) deliveries.push(built.delivery);
    tickets.push(...built.tickets);
    events.push(...built.events);
  }

  return {
    meta: {
      generated_at: iso(NOW),
      generator: 'scripts/seed.js',
      seed: 20240517,
      note: 'Deterministic synthetic data. Re-running produces identical output.',
      counts: {
        customers: customers.length,
        orders: orders.length,
        payments: payments.length,
        deliveries: deliveries.length,
        tickets: tickets.length,
        events: events.length,
      },
    },
    customers,
    orders,
    payments,
    deliveries,
    tickets,
    events,
  };
}

const dataset = generate();
mkdirSync(dirname(OUT_PATH), { recursive: true });
writeFileSync(OUT_PATH, JSON.stringify(dataset, null, 2) + '\n', 'utf8');

const c = dataset.meta.counts;
console.log('Seed written to ' + OUT_PATH);
console.log('  customers=' + c.customers + ' orders=' + c.orders + ' payments=' + c.payments +
  ' deliveries=' + c.deliveries + ' tickets=' + c.tickets + ' events=' + c.events);

const byScenario = dataset.orders.reduce((acc, o) => {
  acc[o.scenario] = (acc[o.scenario] ?? 0) + 1;
  return acc;
}, {});
console.log('  scenario mix:');
for (const [k, v] of Object.entries(byScenario).sort((a, b) => b[1] - a[1])) {
  console.log('    ' + k.padEnd(22) + ' ' + v);
}
console.log('  pinned orders: ' + Object.keys(PINNED).map((n) => 'ORD-' + n).join(', '));
