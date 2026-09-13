/**
 * Agent loop guardrail tests.
 *
 * These use stub providers that misbehave on purpose - looping forever,
 * returning nothing, throwing - because the loop's real job is staying bounded
 * and honest when the model does not cooperate.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Copilot } from '../src/agent/copilot.js';
import { LLMProvider } from '../src/llm/provider.js';

const stubTools = (overrides = {}) => ({
  declarations: [{ name: 'get_order_summary', description: 'x', parameters: { type: 'object', properties: {} } }],
  execute: async (name, args) => ({ ok: true, data: { called: name, args, findings: [] } }),
  ...overrides,
});

class ScriptedProvider extends LLMProvider {
  constructor(turns) {
    super();
    this.turns = turns;
    this.callCount = 0;
  }
  get name() { return 'stub'; }
  async generate() {
    const turn = this.turns[Math.min(this.callCount, this.turns.length - 1)];
    this.callCount++;
    return { text: null, toolCalls: [], usage: {}, finishReason: 'STOP', ...turn };
  }
}

describe('Copilot loop', () => {
  test('returns text directly when the model requests no tools', async () => {
    const copilot = new Copilot({
      provider: new ScriptedProvider([{ text: 'Direct answer.' }]),
      tools: stubTools(),
    });
    const res = await copilot.ask('hello');
    assert.equal(res.answer, 'Direct answer.');
    assert.equal(res.meta.tool_rounds, 0);
    assert.equal(res.meta.stop_reason, 'answered');
  });

  test('executes a requested tool and feeds the result back', async () => {
    const provider = new ScriptedProvider([
      { toolCalls: [{ id: '1', name: 'get_order_summary', args: { order_id: '4521' } }] },
      { text: 'Answer grounded in the tool result.' },
    ]);
    const copilot = new Copilot({ provider, tools: stubTools() });
    const res = await copilot.ask('status of 4521?');

    assert.equal(res.answer, 'Answer grounded in the tool result.');
    assert.equal(res.meta.tool_rounds, 1);
    const toolStep = res.trace.find((t) => t.kind === 'tool');
    assert.equal(toolStep.tool, 'get_order_summary');
    assert.deepEqual(toolStep.args, { order_id: '4521' });
    assert.equal(toolStep.ok, true);
  });

  test('runs parallel tool calls in a single round concurrently', async () => {
    let concurrent = 0;
    let peak = 0;
    const tools = stubTools({
      execute: async (name) => {
        concurrent++;
        peak = Math.max(peak, concurrent);
        await new Promise((r) => setTimeout(r, 20));
        concurrent--;
        return { ok: true, data: { name, findings: [] } };
      },
    });
    const provider = new ScriptedProvider([
      {
        toolCalls: [
          { id: '1', name: 'get_order_summary', args: {} },
          { id: '2', name: 'get_order_summary', args: {} },
        ],
      },
      { text: 'Done.' },
    ]);
    const copilot = new Copilot({ provider, tools });
    await copilot.ask('two things');
    assert.equal(peak, 2, 'tool calls in one round should run in parallel');
  });

  test('stops at the round ceiling when the model loops forever', async () => {
    // Always asks for a tool, never answers.
    const provider = new ScriptedProvider([
      { toolCalls: [{ id: 'x', name: 'get_order_summary', args: {} }] },
    ]);
    const copilot = new Copilot({ provider, tools: stubTools(), maxToolRounds: 3 });
    const res = await copilot.ask('loop forever');

    assert.equal(res.meta.stop_reason, 'max_tool_rounds');
    assert.equal(res.meta.tool_rounds, 3);
    assert.match(res.answer, /could not settle|narrow the question/i);
    assert.ok(provider.callCount <= 4, 'must not exceed maxToolRounds + 1 model calls');
  });

  test('hands tool errors back to the model rather than throwing', async () => {
    const tools = stubTools({
      execute: async () => ({ ok: false, error: { code: 'ORDER_NOT_FOUND', message: 'nope' } }),
    });
    const provider = new ScriptedProvider([
      { toolCalls: [{ id: '1', name: 'get_order_summary', args: {} }] },
      { text: 'That order does not exist.' },
    ]);
    const copilot = new Copilot({ provider, tools });
    const res = await copilot.ask('bad order');

    assert.equal(res.answer, 'That order does not exist.');
    const toolStep = res.trace.find((t) => t.kind === 'tool');
    assert.equal(toolStep.ok, false);
    assert.equal(toolStep.error_code, 'ORDER_NOT_FOUND');
  });

  test('produces a usable answer when the model returns empty text', async () => {
    const copilot = new Copilot({
      provider: new ScriptedProvider([{ text: null }]),
      tools: stubTools(),
    });
    const res = await copilot.ask('hello');
    assert.ok(res.answer.length > 0, 'must never return an empty answer');
  });

  test('propagates provider failures for the error handler to convert', async () => {
    class BrokenProvider extends LLMProvider {
      get name() { return 'broken'; }
      async generate() { throw new Error('upstream 503'); }
    }
    const copilot = new Copilot({ provider: new BrokenProvider(), tools: stubTools() });
    await assert.rejects(() => copilot.ask('anything'), /upstream 503/);
  });

  test('records finding codes in the trace for auditability', async () => {
    const tools = stubTools({
      execute: async () => ({
        ok: true,
        data: { findings: [{ code: 'PAID_NO_DELIVERY_SCHEDULED' }, { code: 'WAREHOUSE_HOLD' }] },
      }),
    });
    const provider = new ScriptedProvider([
      { toolCalls: [{ id: '1', name: 'get_order_summary', args: {} }] },
      { text: 'Answer.' },
    ]);
    const copilot = new Copilot({ provider, tools });
    const res = await copilot.ask('q');
    const toolStep = res.trace.find((t) => t.kind === 'tool');
    assert.deepEqual(toolStep.finding_codes, ['PAID_NO_DELIVERY_SCHEDULED', 'WAREHOUSE_HOLD']);
  });

  test('assigns a unique request id to every call', async () => {
    const copilot = new Copilot({
      provider: new ScriptedProvider([{ text: 'ok' }]),
      tools: stubTools(),
    });
    const a = await copilot.ask('one');
    const b = await copilot.ask('two');
    assert.notEqual(a.request_id, b.request_id);
  });
});
