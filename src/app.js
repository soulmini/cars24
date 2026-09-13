/**
 * Application assembly.
 *
 * Wiring lives here, separate from src/server.js, so tests can build a fully
 * configured app in-process without binding a port.
 */
import express from 'express';
import { config } from './config.js';
import { JsonRepository } from './data/repository.js';
import { createToolRegistry } from './tools/index.js';
import { Copilot } from './agent/copilot.js';
import { GeminiProvider } from './llm/gemini.js';
import { MockProvider } from './llm/mock.js';
import { createRouter } from './api/routes.js';

/**
 * Builds the configured LLM provider.
 *
 * `mock` is not only a test double - it is the documented fallback that keeps
 * the service answering when no key is configured.
 */
export function createProvider(cfg = config) {
  switch (cfg.llm.provider) {
    case 'gemini':
      return new GeminiProvider({
        apiKey: cfg.llm.geminiApiKey,
        model: cfg.llm.model,
        temperature: cfg.llm.temperature,
      });
    case 'mock':
      return new MockProvider();
    default:
      throw new Error(
        'Unknown LLM_PROVIDER "' + cfg.llm.provider + '". Supported values: gemini, mock.',
      );
  }
}

export function createApp({ cfg = config, provider, repo } = {}) {
  const repository = repo ?? JsonRepository.fromFile(cfg.dataPath ?? undefined);
  const tools = createToolRegistry(repository);
  const llm = provider ?? createProvider(cfg);

  const copilot = new Copilot({
    provider: llm,
    tools,
    maxToolRounds: cfg.agent.maxToolRounds,
    timeoutMs: cfg.agent.timeoutMs,
  });

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '256kb' }));

  app.get('/', (req, res) => {
    res.json({
      service: 'ai-operations-copilot',
      description: 'Ask operational questions about orders in natural language.',
      provider: copilot.providerName,
      endpoints: {
        'POST /api/query': 'Ask the copilot a question.',
        'GET  /api/health': 'Service and dataset health.',
        'GET  /api/tools': 'Tools available to the model.',
        'GET  /api/orders/:id': 'Order summary with diagnostics (no LLM).',
        'GET  /api/operations/summary': 'Fleet-wide operational snapshot (no LLM).',
      },
      example: {
        method: 'POST',
        url: '/api/query',
        body: { question: "What's the payment status for order #4521?" },
      },
    });
  });

  app.use('/api', createRouter({ copilot, tools, repo: repository, config: cfg }));

  app.use((req, res) => {
    res.status(404).json({
      error: { code: 'NOT_FOUND', message: 'No route for ' + req.method + ' ' + req.path + '.' },
    });
  });

  // Express 5 forwards async rejections here, so an LLM outage returns a
  // structured 502 rather than a hung socket.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const isLLM = err?.name === 'LLMError';
    const status = isLLM ? 502 : 500;
    if (cfg.nodeEnv !== 'test') {
      console.error('[error]', err?.stack ?? err);
    }

    const message = isLLM
      ? 'The language model is unavailable: ' + err.message
      : 'An unexpected error occurred.';

    // A client that asked for text must not get JSON back on the error path.
    if (String(req.query?.format ?? '').toLowerCase() === 'text') {
      return res.status(status).type('text/plain').send(message);
    }

    res.status(status).json({
      error: {
        code: isLLM ? 'LLM_UNAVAILABLE' : 'INTERNAL_ERROR',
        message,
        retryable: Boolean(err?.retryable),
      },
    });
  });

  return { app, copilot, tools, repo: repository };
}

export default createApp;
