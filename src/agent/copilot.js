/**
 * The agent loop.
 *
 * Shape: ask the model -> it either answers or requests tools -> run the tools
 * locally -> feed results back -> repeat until it answers or we hit the round
 * ceiling.
 *
 * Three properties matter more than cleverness here:
 *
 *   Bounded. maxToolRounds caps model round trips and a wall-clock budget caps
 *   total latency. A confused model degrades into a slow honest answer, never
 *   an infinite spend.
 *
 *   Observable. Every tool call, its arguments, its latency and its outcome go
 *   into a trace returned with the response. When an ops agent disputes an
 *   answer, the trace shows exactly which rows produced it.
 *
 *   Recoverable. Tool errors are handed back to the model as data, so a wrong
 *   order id becomes a graceful "no such order" rather than a 500.
 */
import { randomUUID } from 'node:crypto';
import { SYSTEM_PROMPT } from './prompt.js';

export class Copilot {
  #provider;
  #tools;
  #maxRounds;
  #timeoutMs;

  constructor({ provider, tools, maxToolRounds = 5, timeoutMs = 30000 }) {
    this.#provider = provider;
    this.#tools = tools;
    this.#maxRounds = maxToolRounds;
    this.#timeoutMs = timeoutMs;
  }

  get providerName() {
    return this.#provider.name;
  }

  /**
   * Answers one question.
   *
   * @param {string} question      The ops agent's query.
   * @param {Array}  history       Prior [{role:'user'|'model', content}] turns.
   * @returns {Promise<object>}    { answer, trace, meta }
   */
  async ask(question, history = []) {
    const requestId = randomUUID();
    const startedAt = Date.now();
    const deadline = startedAt + this.#timeoutMs;

    const trace = [];
    const messages = [
      ...history.map((h) => ({ role: h.role === 'assistant' ? 'model' : h.role, content: h.content })),
      { role: 'user', content: question },
    ];

    let rounds = 0;
    let finalText = null;
    let stopReason = 'answered';
    const usage = { input_tokens: 0, output_tokens: 0 };

    while (rounds <= this.#maxRounds) {
      if (Date.now() > deadline) {
        stopReason = 'timeout';
        break;
      }

      const turnStart = Date.now();
      const response = await this.#provider.generate({
        system: SYSTEM_PROMPT,
        messages,
        tools: this.#tools.declarations,
      });

      usage.input_tokens += response.usage?.input_tokens ?? 0;
      usage.output_tokens += response.usage?.output_tokens ?? 0;

      trace.push({
        step: trace.length + 1,
        kind: 'model',
        duration_ms: Date.now() - turnStart,
        requested_tools: response.toolCalls.map((c) => c.name),
        finish_reason: response.finishReason,
      });

      // No tools requested: this is the answer.
      if (!response.toolCalls.length) {
        finalText = response.text;
        break;
      }

      if (rounds === this.#maxRounds) {
        // Ceiling reached with tools still pending. Stop rather than loop.
        stopReason = 'max_tool_rounds';
        finalText = response.text;
        break;
      }

      messages.push({
        role: 'model',
        content: response.text,
        toolCalls: response.toolCalls,
      });

      // Tool calls in one round are independent, so run them concurrently.
      const results = await Promise.all(
        response.toolCalls.map(async (call) => {
          const toolStart = Date.now();
          const result = await this.#tools.execute(call.name, call.args);
          trace.push({
            step: trace.length + 1,
            kind: 'tool',
            tool: call.name,
            args: call.args,
            ok: result.ok,
            error_code: result.ok ? null : result.error.code,
            duration_ms: Date.now() - toolStart,
            // The diagnosis is the part an auditor cares about, so surface the
            // finding codes in the trace without dumping the whole payload.
            finding_codes: result.ok ? (result.data?.findings ?? []).map((f) => f.code) : [],
          });
          return { id: call.id, name: call.name, result };
        }),
      );

      messages.push({ role: 'tool', results });
      rounds++;
    }

    if (!finalText) {
      finalText = this.#fallbackAnswer(stopReason, trace);
    }

    return {
      request_id: requestId,
      answer: finalText.trim(),
      meta: {
        provider: this.#provider.name,
        tool_rounds: rounds,
        stop_reason: stopReason,
        duration_ms: Date.now() - startedAt,
        usage,
      },
      trace,
    };
  }

  /**
   * When the loop ends without model text, we still owe the user a usable
   * answer. If tools ran successfully we say what we found rather than
   * returning an empty string.
   */
  #fallbackAnswer(stopReason, trace) {
    const okTools = trace.filter((t) => t.kind === 'tool' && t.ok);

    if (stopReason === 'timeout') {
      return okTools.length
        ? 'I ran out of time composing the answer, but I did retrieve the records (' +
          okTools.map((t) => t.tool).join(', ') + '). Please retry.'
        : 'The request timed out before I could retrieve anything. Please retry.';
    }

    if (stopReason === 'max_tool_rounds') {
      return 'I could not settle on an answer within the allowed number of lookups. ' +
        'Please narrow the question - for example, give a single order number.';
    }

    return 'I was unable to produce an answer for that question.';
  }
}

export default Copilot;
