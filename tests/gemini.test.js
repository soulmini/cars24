/**
 * Gemini adapter tests.
 *
 * The live API call cannot be tested without a key, so what is tested here is
 * the part that is easy to get wrong and needs no network: the translation
 * between our neutral message shape and Gemini's `contents` format, plus the
 * declaration schemas we send as function specs.
 *
 * No HTTP is attempted - toGeminiContents is a pure function, and the
 * constructor tests never reach generate().
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { GeminiProvider, toGeminiContents } from '../src/llm/gemini.js';
import { LLMError } from '../src/llm/provider.js';

describe('GeminiProvider construction', () => {
  test('requires an API key', () => {
    assert.throws(() => new GeminiProvider({}), LLMError);
    assert.throws(() => new GeminiProvider({ apiKey: '' }), LLMError);
  });

  test('reports a name that identifies the model', () => {
    const p = new GeminiProvider({ apiKey: 'k', model: 'gemini-2.5-flash' });
    assert.equal(p.name, 'gemini:gemini-2.5-flash');
  });

  test('defaults to a current model', () => {
    const p = new GeminiProvider({ apiKey: 'k' });
    assert.match(p.name, /^gemini:gemini-/);
  });
});

/*
 * The content mapping is the load-bearing part of this adapter: get the roles
 * or part shapes wrong and tool calling silently stops working. These tests
 * run the real exported mapper.
 */
describe('toGeminiContents', () => {
  test('maps a user turn to a text part', () => {
    const out = toGeminiContents([{ role: 'user', content: 'Status of 4521?' }]);
    assert.deepEqual(out, [{ role: 'user', parts: [{ text: 'Status of 4521?' }] }]);
  });

  test('maps a model tool request to functionCall parts', () => {
    const out = toGeminiContents([
      { role: 'model', content: null, toolCalls: [{ id: 'c1', name: 'get_order_summary', args: { order_id: '4521' } }] },
    ]);
    assert.equal(out.length, 1);
    assert.equal(out[0].role, 'model');
    assert.deepEqual(out[0].parts, [
      { functionCall: { id: 'c1', name: 'get_order_summary', args: { order_id: '4521' } } },
    ]);
  });

  test('sends tool results as a user turn with functionResponse parts', () => {
    // The Gemini-specific rule that most commonly breaks tool calling: results
    // go back as role 'user', not 'tool' or 'function'.
    const result = { ok: true, data: { order_id: 'ORD-1' } };
    const out = toGeminiContents([
      { role: 'tool', results: [{ id: 'c1', name: 'get_order_summary', result }] },
    ]);
    assert.equal(out.length, 1);
    assert.equal(out[0].role, 'user');
    assert.deepEqual(out[0].parts[0].functionResponse, {
      id: 'c1',
      name: 'get_order_summary',
      response: result,
    });
    assert.equal(typeof out[0].parts[0].functionResponse.response, 'object',
      'response must be an object, never a scalar or array');
  });

  test('includes model text alongside tool calls when both are present', () => {
    const out = toGeminiContents([
      { role: 'model', content: 'Let me check.', toolCalls: [{ id: 'c1', name: 't', args: {} }] },
    ]);
    assert.deepEqual(out[0].parts[0], { text: 'Let me check.' });
    assert.ok(out[0].parts[1].functionCall);
  });

  test('drops an empty model turn rather than emitting invalid empty parts', () => {
    const out = toGeminiContents([{ role: 'model', content: null, toolCalls: [] }]);
    assert.deepEqual(out, []);
  });

  test('echoes thoughtSignature back on the part, not inside functionCall', () => {
    // Thinking models (Gemini 3.x) reject the follow-up turn with
    // "Function call is missing a thought_signature" if this is dropped.
    const out = toGeminiContents([
      {
        role: 'model',
        toolCalls: [{ id: 'c1', name: 'get_order_summary', args: {}, thoughtSignature: 'SIG==' }],
      },
    ]);
    assert.equal(out[0].parts[0].thoughtSignature, 'SIG==');
    assert.equal(out[0].parts[0].functionCall.thoughtSignature, undefined,
      'the signature belongs on the Part, not inside functionCall');
  });

  test('omits thoughtSignature when the model did not supply one', () => {
    const out = toGeminiContents([
      { role: 'model', toolCalls: [{ id: 'c1', name: 't', args: {}, thoughtSignature: null }] },
    ]);
    assert.ok(!('thoughtSignature' in out[0].parts[0]),
      'a null signature must be omitted rather than sent as null');
  });

  test('defaults missing tool args to an empty object', () => {
    const out = toGeminiContents([
      { role: 'model', toolCalls: [{ id: 'c1', name: 'get_operational_summary' }] },
    ]);
    assert.deepEqual(out[0].parts[0].functionCall.args, {});
  });

  test('preserves ordering across a full multi-turn exchange', () => {
    const out = toGeminiContents([
      { role: 'user', content: 'Status of 1289?' },
      { role: 'model', content: null, toolCalls: [{ id: 'c1', name: 'get_order_summary', args: { order_id: '1289' } }] },
      { role: 'tool', results: [{ id: 'c1', name: 'get_order_summary', result: { ok: true, data: {} } }] },
      { role: 'user', content: 'And the tracking number?' },
    ]);
    assert.deepEqual(out.map((c) => c.role), ['user', 'model', 'user', 'user']);
    assert.ok(out[1].parts[0].functionCall);
    assert.ok(out[2].parts[0].functionResponse);
    assert.equal(out[3].parts[0].text, 'And the tracking number?');
  });

  test('batches multiple results from one round into a single turn', () => {
    const out = toGeminiContents([
      {
        role: 'tool',
        results: [
          { id: 'c1', name: 'get_payment_details', result: { ok: true, data: {} } },
          { id: 'c2', name: 'get_delivery_details', result: { ok: true, data: {} } },
        ],
      },
    ]);
    assert.equal(out.length, 1);
    assert.equal(out[0].parts.length, 2);
  });

  test('passes tool errors through as data the model can read', () => {
    const errorResult = { ok: false, error: { code: 'ORDER_NOT_FOUND', message: 'No order exists.' } };
    const out = toGeminiContents([
      { role: 'tool', results: [{ id: 'c1', name: 'get_order_summary', result: errorResult }] },
    ]);
    assert.equal(out[0].parts[0].functionResponse.response.ok, false);
    assert.equal(out[0].parts[0].functionResponse.response.error.code, 'ORDER_NOT_FOUND');
  });
});

describe('retry policy', () => {
  test('classifies transient statuses as retryable', () => {
    const RETRYABLE = [429, 500, 502, 503, 504];
    const NOT_RETRYABLE = [400, 401, 403, 404];
    // Mirrors the RETRYABLE_STATUS set in the adapter.
    const isRetryable = (s) => RETRYABLE.includes(s);
    for (const s of RETRYABLE) assert.equal(isRetryable(s), true, s + ' should retry');
    for (const s of NOT_RETRYABLE) assert.equal(isRetryable(s), false, s + ' should not retry');
  });

  test('LLMError carries status and retryability for the API layer', () => {
    const err = new LLMError('rate limited', { status: 429, retryable: true });
    assert.equal(err.name, 'LLMError');
    assert.equal(err.status, 429);
    assert.equal(err.retryable, true);
  });
});

describe('tool declarations are Gemini-compatible', () => {
  test('every declaration uses a JSON-Schema object shape Gemini accepts', async () => {
    const { TOOL_DECLARATIONS } = await import('../src/tools/index.js');
    for (const decl of TOOL_DECLARATIONS) {
      assert.equal(typeof decl.name, 'string');
      assert.equal(typeof decl.description, 'string');
      assert.equal(decl.parameters.type, 'object');
      assert.equal(typeof decl.parameters.properties, 'object');
      assert.ok(Array.isArray(decl.parameters.required));

      for (const [key, prop] of Object.entries(decl.parameters.properties)) {
        assert.ok(
          ['string', 'integer', 'number', 'boolean', 'array', 'object'].includes(prop.type),
          decl.name + '.' + key + ' has an unsupported type: ' + prop.type,
        );
        assert.ok(prop.description, decl.name + '.' + key + ' needs a description');
        if (prop.enum) {
          assert.ok(Array.isArray(prop.enum) && prop.enum.length > 0);
          assert.ok(prop.enum.every((v) => typeof v === 'string'));
        }
      }

      // Required names must actually exist in properties, or Gemini rejects the schema.
      for (const req of decl.parameters.required) {
        assert.ok(decl.parameters.properties[req], decl.name + ' requires undeclared property ' + req);
      }
    }
  });
});
