#!/usr/bin/env node
/**
 * Process entry point: boot banner, listener and graceful shutdown.
 */
import { createApp } from './app.js';
import { config, describeConfig } from './config.js';

const { app, repo } = createApp();

const server = app.listen(config.port, () => {
  console.log('');
  console.log('AI Operations Copilot');
  console.log('  ' + describeConfig());
  console.log('  dataset       : ' + repo.meta.counts.orders + ' orders, as of ' +
    repo.meta.generated_at.slice(0, 10));
  console.log('  listening on  : http://localhost:' + config.port);

  if (config.llm.usingMockFallback) {
    console.log('');
    console.log('  NOTE: GEMINI_API_KEY is not set, so the deterministic mock provider is');
    console.log('        active. The service is fully functional; answers are templated');
    console.log('        rather than model-generated. Set GEMINI_API_KEY in .env for Gemini.');
  }
  console.log('');
});

function shutdown(signal) {
  console.log('\n' + signal + ' received, shutting down.');
  server.close(() => process.exit(0));
  // Don't let a hung keep-alive connection block exit forever.
  setTimeout(() => process.exit(1), 10000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
