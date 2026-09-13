/**
 * Google Gemini provider.
 *
 * Translates the normalised conversation shape into the @google/genai
 * `contents` format and back. Everything Gemini-specific lives in this file.
 */
import { GoogleGenAI } from '@google/genai';
import { LLMProvider, LLMError } from './provider.js';

const DEFAULT_MODEL = 'gemini-3.6-flash';

/** Retries transient failures only. A 400 means our request is wrong - retrying wastes time. */
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const MAX_RETRIES = 3;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Extracts the server's suggested retry delay from a quota error.
 *
 * Gemini returns a RetryInfo detail ("retryDelay": "31s") on a 429. Respecting
 * it matters on the free tier, where the window is a full 30s and a guessed
 * 500ms backoff simply wastes the retry budget.
 */
export function retryDelayMs(err) {
  const details = err?.details ?? err?.error?.details;
  const fromStructured = Array.isArray(details)
    ? details.find((d) => d['@type']?.includes('RetryInfo'))?.retryDelay
    : null;

  // The SDK often surfaces the payload as a JSON string in err.message.
  const raw = fromStructured ?? String(err?.message ?? '').match(/"retryDelay"\s*:\s*"([^"]+)"/)?.[1];
  if (!raw) return null;

  const seconds = Number(String(raw).replace(/s$/, ''));
  if (!Number.isFinite(seconds)) return null;

  // Cap it: a multi-minute hint should surface as an error, not a hung request.
  return Math.min(Math.ceil(seconds * 1000) + 500, 45000);
}

/**
 * Converts our neutral message list into Gemini `contents`.
 *
 * Two non-obvious rules live here, both of which silently break tool calling
 * if you get them wrong:
 *
 *   1. Tool results go back as a `user`-role turn containing functionResponse
 *      parts - not a `tool` or `function` role.
 *
 *   2. Thinking models (Gemini 3.x) attach an opaque `thoughtSignature` to the
 *      part carrying a function call, and REQUIRE it to be echoed back on the
 *      next request. Drop it and the API rejects the follow-up turn with
 *      "Function call is missing a thought_signature". The signature belongs on
 *      the Part, not inside functionCall.
 */
export function toGeminiContents(messages) {
  const contents = [];

  for (const msg of messages) {
    if (msg.role === 'user') {
      contents.push({ role: 'user', parts: [{ text: msg.content }] });
      continue;
    }

    if (msg.role === 'model') {
      const parts = [];
      if (msg.content) parts.push({ text: msg.content });
      for (const call of msg.toolCalls ?? []) {
        const part = { functionCall: { id: call.id, name: call.name, args: call.args ?? {} } };
        if (call.thoughtSignature) part.thoughtSignature = call.thoughtSignature;
        parts.push(part);
      }
      if (parts.length) contents.push({ role: 'model', parts });
      continue;
    }

    if (msg.role === 'tool') {
      contents.push({
        role: 'user',
        parts: msg.results.map((r) => ({
          functionResponse: {
            id: r.id,
            name: r.name,
            // Gemini requires an object here, never a bare array or scalar.
            response: r.result,
          },
        })),
      });
    }
  }

  return contents;
}

export class GeminiProvider extends LLMProvider {
  #client;
  #model;
  #temperature;

  constructor({ apiKey, model = DEFAULT_MODEL, temperature = 0.2 } = {}) {
    super();
    if (!apiKey) throw new LLMError('GEMINI_API_KEY is required to use the Gemini provider.');
    this.#client = new GoogleGenAI({ apiKey });
    this.#model = model;
    this.#temperature = temperature;
  }

  get name() {
    return 'gemini:' + this.#model;
  }

  async generate({ system, messages, tools }) {
    const contents = toGeminiContents(messages);

    const config = {
      temperature: this.#temperature,
      systemInstruction: system,
    };
    if (tools?.length) {
      config.tools = [{ functionDeclarations: tools }];
    }

    let lastErr;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const response = await this.#client.models.generateContent({
          model: this.#model,
          contents,
          config,
        });

        // Read the parts directly rather than using response.functionCalls:
        // that helper flattens the calls and drops the per-part
        // thoughtSignature, which thinking models require us to echo back.
        const parts = response.candidates?.[0]?.content?.parts ?? [];
        const toolCalls = [];
        const textChunks = [];

        for (const [i, part] of parts.entries()) {
          if (part.functionCall) {
            toolCalls.push({
              id: part.functionCall.id ?? this.#model + '-call-' + attempt + '-' + i,
              name: part.functionCall.name,
              args: part.functionCall.args ?? {},
              thoughtSignature: part.thoughtSignature ?? null,
            });
          } else if (typeof part.text === 'string' && !part.thought) {
            textChunks.push(part.text);
          }
        }

        const text = textChunks.join('').trim();
        return {
          text: text || null,
          toolCalls,
          usage: {
            input_tokens: response.usageMetadata?.promptTokenCount ?? null,
            output_tokens: response.usageMetadata?.candidatesTokenCount ?? null,
          },
          finishReason: response.candidates?.[0]?.finishReason ?? null,
        };
      } catch (err) {
        const status = err?.status ?? err?.code;
        lastErr = err;
        if (!RETRYABLE_STATUS.has(Number(status)) || attempt === MAX_RETRIES) {
          throw new LLMError('Gemini request failed: ' + err.message, {
            cause: err,
            status,
            retryable: RETRYABLE_STATUS.has(Number(status)),
          });
        }
        // Honour the server's own retry hint when it sends one - a free-tier
        // 429 asks for ~30s, and guessing shorter just burns the next attempt.
        // Otherwise exponential backoff with jitter, so concurrent retries do
        // not all land at the same instant.
        const retryHint = retryDelayMs(err);
        const backoff = retryHint ?? (2 ** attempt * 500 + Math.random() * 250);
        await sleep(backoff);
      }
    }

    throw new LLMError('Gemini request failed after retries: ' + lastErr?.message, { cause: lastErr });
  }
}

export default GeminiProvider;
