/**
 * Configuration, resolved once at startup from the environment.
 *
 * Provider selection is deliberately forgiving: if LLM_PROVIDER is `gemini`
 * but no key is present, we fall back to the mock rather than crashing, and
 * say so loudly at boot. A reviewer who clones this repo gets a working
 * service on the first `npm start`, key or not.
 */
import 'dotenv/config';

function bool(value, fallback = false) {
  if (value === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

const requestedProvider = (process.env.LLM_PROVIDER ?? 'gemini').toLowerCase();
const geminiKey = process.env.GEMINI_API_KEY?.trim() || process.env.GOOGLE_API_KEY?.trim() || '';

const usingMockFallback = requestedProvider === 'gemini' && !geminiKey;

export const config = {
  port: Number(process.env.PORT ?? 3000),
  nodeEnv: process.env.NODE_ENV ?? 'development',

  llm: {
    requestedProvider,
    provider: usingMockFallback ? 'mock' : requestedProvider,
    usingMockFallback,
    geminiApiKey: geminiKey,
    model: process.env.GEMINI_MODEL ?? 'gemini-3.6-flash',
    temperature: Number(process.env.LLM_TEMPERATURE ?? 0.2),
  },

  agent: {
    /** Hard ceiling on tool-calling rounds, so a looping model cannot burn budget. */
    maxToolRounds: Number(process.env.AGENT_MAX_TOOL_ROUNDS ?? 5),
    /** Per-request wall clock budget in ms. */
    timeoutMs: Number(process.env.AGENT_TIMEOUT_MS ?? 90000),
  },

  api: {
    /** Returns the tool trace in responses. On by default: ops staff need auditability. */
    exposeTrace: bool(process.env.EXPOSE_TRACE, true),
    rateLimit: {
      windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS ?? 60000),
      max: Number(process.env.RATE_LIMIT_MAX ?? 60),
    },
  },

  dataPath: process.env.SEED_PATH ?? null,
};

export function describeConfig() {
  const lines = [
    'provider      : ' + config.llm.provider + (config.llm.usingMockFallback ? ' (fallback)' : ''),
    'model         : ' + (config.llm.provider === 'gemini' ? config.llm.model : 'n/a'),
    'max tool rounds: ' + config.agent.maxToolRounds,
    'port          : ' + config.port,
  ];
  return lines.join('\n  ');
}

export default config;
