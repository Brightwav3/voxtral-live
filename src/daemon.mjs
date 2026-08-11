import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

import { loadConfig } from './config.mjs';
import { emitEvent } from './events.mjs';

export function startDaemon({ env = process.env, argv = process.argv.slice(2), write = process.stdout.write } = {}) {
  const config = loadConfig(env, argv);
  const sessionId = `s_${Date.now().toString(36)}`;

  emitEvent({ event: 'daemon_started', sessionId, mode: config.mode }, write);
  emitEvent({ event: 'listening', sessionId }, write);

  const shutdown = () => {
    emitEvent({ event: 'daemon_stopped', sessionId }, write);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  return { config, sessionId, shutdown };
}

const isMainModule = process.argv[1]
  && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isMainModule) startDaemon();
