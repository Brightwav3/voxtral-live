#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

import { requestControl } from './control-ipc.mjs';

export function parseControlCommand(argv = []) {
  const [name, ...rest] = argv;
  if (name === 'status' || name === 'interrupt') {
    if (rest.length > 0) throw cliError(`${name} does not accept arguments`);
    return { command: name, params: {} };
  }
  if (name === 'stop') {
    if (rest.length > 0) throw cliError('stop does not accept arguments');
    return { command: 'shutdown', params: {} };
  }
  if (name === 'say') {
    const text = rest.join(' ').trim();
    if (!text) throw cliError('say requires text');
    return { command: 'say', params: { text } };
  }
  throw cliError('Expected one of: status, say TEXT, interrupt, stop');
}

export async function runControlCli({
  argv = process.argv.slice(2),
  request = requestControl,
  write = process.stdout.write.bind(process.stdout),
} = {}) {
  const command = parseControlCommand(argv);
  const result = await request(command);
  write(`${JSON.stringify({ ok: true, command: command.command, result })}\n`);
  return result;
}

function cliError(message) {
  const error = new Error(message);
  error.code = 'invalid_cli_command';
  return error;
}

const isMainModule = process.argv[1]
  && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isMainModule) {
  try {
    await runControlCli();
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      error: {
        code: typeof error?.code === 'string' ? error.code : 'control_error',
        message: error?.message ?? 'Control command failed',
      },
    })}\n`);
    process.exitCode = 2;
  }
}
