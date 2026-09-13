/**
 * LLM provider interface.
 *
 * The agent loop depends on this shape, not on Gemini. A provider takes a
 * conversation plus tool declarations and returns either tool calls or final
 * text - the loop does not care which vendor produced them.
 *
 * That indirection buys two things: the mock provider below lets the whole
 * service (and its test suite) run with no API key and no network, and
 * swapping vendors is a new file rather than a rewrite.
 *
 * Normalised request:
 *   { system, messages: [{ role: 'user'|'model'|'tool', ... }], tools }
 *
 * Normalised response:
 *   { toolCalls: [{ id, name, args }], text: string|null, usage, finishReason }
 */

export class LLMError extends Error {
  constructor(message, { cause, status, retryable = false } = {}) {
    super(message);
    this.name = 'LLMError';
    this.cause = cause;
    this.status = status;
    this.retryable = retryable;
  }
}

/**
 * Base class documenting the contract. Providers override `generate`.
 */
export class LLMProvider {
  get name() {
    return 'abstract';
  }

  // eslint-disable-next-line no-unused-vars
  async generate({ system, messages, tools }) {
    throw new Error('generate() must be implemented by a provider');
  }
}

export default LLMProvider;
