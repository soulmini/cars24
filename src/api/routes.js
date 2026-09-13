/**
 * HTTP surface.
 *
 * The copilot is one endpoint (POST /api/query). The direct REST routes
 * alongside it exist because an ops dashboard should not have to pay for an
 * LLM round trip to render an order page - and because they make the tool
 * layer independently testable and debuggable.
 */
import { Router } from 'express';
import { normalizeOrderId } from '../data/repository.js';

/** Minimal fixed-window rate limiter. In-process, so single-instance only. */
function rateLimiter({ windowMs, max }) {
  const hits = new Map();

  // Sweep expired buckets so the map cannot grow without bound.
  const sweep = setInterval(() => {
    const cutoff = Date.now() - windowMs;
    for (const [key, bucket] of hits) {
      if (bucket.start < cutoff) hits.delete(key);
    }
  }, windowMs);
  sweep.unref();

  return function limiter(req, res, next) {
    const key = req.ip ?? 'unknown';
    const now = Date.now();
    const bucket = hits.get(key);

    if (!bucket || now - bucket.start >= windowMs) {
      hits.set(key, { start: now, count: 1 });
      return next();
    }

    bucket.count++;
    if (bucket.count > max) {
      const retryAfter = Math.ceil((bucket.start + windowMs - now) / 1000);
      const message = 'Too many requests. Retry in ' + retryAfter + 's.';
      res.set('Retry-After', String(retryAfter));
      if (wantsText(req)) return res.status(429).type('text/plain').send(message);
      return res.status(429).json({ error: { code: 'RATE_LIMITED', message } });
    }
    return next();
  };
}

/**
 * Decides whether the caller wants the bare answer instead of the full
 * envelope.
 *
 * Two ways to ask, because the two callers are different: a dashboard sends
 * `Accept: text/plain`, while a human at a terminal wants `?format=text`
 * without wrestling with curl headers. The explicit query parameter wins over
 * the header, since it can only have been typed deliberately.
 */
function wantsText(req) {
  const format = String(req.query.format ?? '').toLowerCase();
  if (format === 'text') return true;
  if (format === 'json') return false;

  // Only honour an explicit text/plain preference. Browsers and fetch() send
  // Accept headers containing star/star, which must not flip the default.
  const accept = String(req.get('accept') ?? '');
  return accept.includes('text/plain') && !accept.includes('application/json');
}

export function createRouter({ copilot, tools, repo, config }) {
  const router = Router();

  /** Sends an error in whichever format the caller asked for. */
  function sendError(req, res, status, error) {
    if (wantsText(req)) {
      return res.status(status).type('text/plain').send(error.message);
    }
    return res.status(status).json({ error });
  }

  router.get('/health', (req, res) => {
    res.json({
      status: 'ok',
      provider: copilot.providerName,
      using_mock_fallback: config.llm.usingMockFallback,
      dataset: repo.meta.counts,
      as_of: repo.meta.generated_at,
      uptime_s: Math.round(process.uptime()),
    });
  });

  router.get('/tools', (req, res) => {
    res.json({
      count: tools.declarations.length,
      tools: tools.declarations.map((t) => ({
        name: t.name,
        description: t.description,
        parameters: Object.keys(t.parameters.properties ?? {}),
        required: t.parameters.required ?? [],
      })),
    });
  });

  /* --- the copilot ------------------------------------------------- */
  router.post(
    '/query',
    rateLimiter(config.api.rateLimit),
    async (req, res, next) => {
      try {
        const { question, history } = req.body ?? {};

        if (typeof question !== 'string' || !question.trim()) {
          return sendError(req, res, 400, {
            code: 'INVALID_REQUEST',
            message: 'Body must include a non-empty "question" string.',
          });
        }
        if (question.length > 2000) {
          return sendError(req, res, 400, {
            code: 'QUESTION_TOO_LONG',
            message: 'Questions are limited to 2000 characters.',
          });
        }
        if (history !== undefined && !Array.isArray(history)) {
          return sendError(req, res, 400, {
            code: 'INVALID_HISTORY',
            message: '"history" must be an array of {role, content}.',
          });
        }

        const result = await copilot.ask(question.trim(), history ?? []);

        // Plain text: just the answer. The trace still exists server-side and
        // is still logged - it is omitted from the response, not discarded.
        if (wantsText(req)) {
          return res.type('text/plain').send(result.answer);
        }

        if (!config.api.exposeTrace) delete result.trace;
        return res.json(result);
      } catch (err) {
        return next(err);
      }
    },
  );

  /* --- direct data access (no LLM in the path) --------------------- */
  router.get('/orders/:id', async (req, res) => {
    const result = await tools.execute('get_order_summary', { order_id: req.params.id });
    if (!result.ok) {
      const status = result.error.code === 'ORDER_NOT_FOUND' ? 404 : 400;
      return res.status(status).json({ error: result.error });
    }
    return res.json(result.data);
  });

  router.get('/orders/:id/payments', async (req, res) => {
    const result = await tools.execute('get_payment_details', { order_id: req.params.id });
    if (!result.ok) {
      const status = result.error.code === 'ORDER_NOT_FOUND' ? 404 : 400;
      return res.status(status).json({ error: result.error });
    }
    return res.json(result.data);
  });

  router.get('/orders/:id/delivery', async (req, res) => {
    const result = await tools.execute('get_delivery_details', { order_id: req.params.id });
    if (!result.ok) {
      const status = result.error.code === 'ORDER_NOT_FOUND' ? 404 : 400;
      return res.status(status).json({ error: result.error });
    }
    return res.json(result.data);
  });

  router.get('/orders/:id/timeline', async (req, res) => {
    const result = await tools.execute('get_order_timeline', { order_id: req.params.id });
    if (!result.ok) {
      const status = result.error.code === 'ORDER_NOT_FOUND' ? 404 : 400;
      return res.status(status).json({ error: result.error });
    }
    return res.json(result.data);
  });

  router.get('/orders', async (req, res) => {
    const result = await tools.execute('search_orders', {
      status: req.query.status,
      payment_status: req.query.payment_status,
      delivery_status: req.query.delivery_status,
      customer_id: req.query.customer_id,
      limit: req.query.limit,
    });
    if (!result.ok) return res.status(400).json({ error: result.error });
    return res.json(result.data);
  });

  router.get('/operations/summary', async (req, res) => {
    const result = await tools.execute('get_operational_summary', {});
    return res.json(result.data);
  });

  // Small helper that makes the normaliser's behaviour inspectable.
  router.get('/debug/normalize/:ref', (req, res) => {
    res.json({ input: req.params.ref, normalized: normalizeOrderId(req.params.ref) });
  });

  return router;
}

export default createRouter;
