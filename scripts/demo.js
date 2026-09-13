#!/usr/bin/env node
/**
 * Walks the copilot through the three questions from the problem statement
 * plus a few harder ones, in-process (no server needed).
 *
 *   npm run demo
 *
 * Uses whichever provider the environment selects, so it is also the quickest
 * way to sanity-check a real GEMINI_API_KEY end to end.
 */
import { createApp } from '../src/app.js';
import { config } from '../src/config.js';

const QUESTIONS = [
  "What's the payment status for order #4521?",
  "Customer says they've paid for order #1289 but delivery isn't scheduled - what's going on?",
  'Give me a full status summary for order #2231.',
  'What is the tracking number for order 2231?',
  'What happened with order 4521? Show me the history.',
  'Give me an operational overview of the business.',
  'What is the status of order #9999?',
];

const line = (ch = '-') => console.log(ch.repeat(78));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The Gemini free tier allows only a handful of requests per minute, and each
 * question here costs two model calls. Pace the demo so a free-tier key gets
 * through all seven questions instead of tripping quota halfway. Override with
 * DEMO_DELAY_MS=0 on a paid key.
 */
const DELAY_MS = Number(process.env.DEMO_DELAY_MS ?? (config.llm.provider === 'gemini' ? 30000 : 0));

const { copilot } = createApp();

console.log('');
line('=');
console.log('AI Operations Copilot - demo');
console.log('provider: ' + copilot.providerName);
if (config.llm.usingMockFallback) {
  console.log('note    : no GEMINI_API_KEY set, using the deterministic mock provider.');
}
line('=');

if (DELAY_MS) {
  console.log('pacing : ' + DELAY_MS / 1000 + 's between questions to stay inside free-tier quota');
  console.log('         (set DEMO_DELAY_MS=0 to disable on a paid key)');
}

let first = true;
for (const question of QUESTIONS) {
  if (!first && DELAY_MS) await sleep(DELAY_MS);
  first = false;

  console.log('');
  console.log('Q: ' + question);
  line();

  try {
    const res = await copilot.ask(question);
    console.log(res.answer);
    line();

    const toolSteps = res.trace.filter((t) => t.kind === 'tool');
    console.log('tools: ' + (toolSteps.map((t) => t.tool + (t.ok ? '' : ' [' + t.error_code + ']')).join(', ') || 'none') +
      ' | rounds: ' + res.meta.tool_rounds +
      ' | ' + res.meta.duration_ms + 'ms' +
      ' | stop: ' + res.meta.stop_reason);

    const findings = toolSteps.flatMap((t) => t.finding_codes ?? []);
    if (findings.length) console.log('findings: ' + findings.join(', '));
  } catch (err) {
    console.error('FAILED: ' + err.message);
  }
}

console.log('');
line('=');
console.log('Demo complete.');
