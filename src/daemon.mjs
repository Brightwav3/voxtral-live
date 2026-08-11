import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

import { loadConfig } from './config.mjs';
import { emitEvent } from './events.mjs';

const defaultWrite = process.stdout.write.bind(process.stdout);

export function startDaemon({ env = process.env, argv = process.argv.slice(2), write = defaultWrite } = {}) {
  const config = loadConfig(env, argv);
  const sessionId = `s_${Date.now().toString(36)}`;

  emitEvent({ event: 'daemon_started', sessionId, mode: config.mode }, write);
  emitEvent({ event: 'listening', sessionId }, write);

  const shutdown = () => {
    emitEvent({ event: 'daemon_stopped', sessionId }, write);
  };
  if (!argv.includes('--once')) {
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  }

  return { config, sessionId, shutdown };
}

const isMainModule = process.argv[1]
  && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isMainModule) {
  if (process.argv.includes('--control')) {
    emitEvent({
      event: 'error',
      code: 'control_not_implemented',
      recoverable: false,
      message: 'Local control is not implemented until Task 8.',
    });
    process.exitCode = 2;
  } else {
    startDaemon();
  }
}
