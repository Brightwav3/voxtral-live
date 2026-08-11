import test from 'node:test';
import assert from 'node:assert/strict';

import { createControlServer, requestControl } from '../src/control-ipc.mjs';
import { parseControlCommand } from '../src/control-cli.mjs';

test('serves status, say, interrupt, and shutdown over one local pipe', async (t) => {
  const calls = [];
  const server = createControlServer({
    pipePath: uniquePipePath('commands'),
    handlers: {
      status: async () => ({ state: 'LISTENING', turnId: 't_4' }),
      say: async ({ text }) => { calls.push(['say', text]); return { accepted: true }; },
      interrupt: async () => { calls.push(['interrupt']); return { interrupted: true }; },
      shutdown: async () => { calls.push(['shutdown']); return { stopping: true }; },
    },
  });
  t.after(() => server.close());
  await server.start();

  assert.deepEqual(await requestControl({ pipePath: server.pipePath, command: 'status' }), {
    state: 'LISTENING',
    turnId: 't_4',
  });
  assert.deepEqual(await requestControl({
    pipePath: server.pipePath,
    command: 'say',
    params: { text: 'Hello from IPC' },
  }), { accepted: true });
  assert.deepEqual(await requestControl({ pipePath: server.pipePath, command: 'interrupt' }), { interrupted: true });
  assert.deepEqual(await requestControl({ pipePath: server.pipePath, command: 'shutdown' }), { stopping: true });
  assert.deepEqual(calls, [['say', 'Hello from IPC'], ['interrupt'], ['shutdown']]);
});

test('rejects a second control client while shutdown is in progress', async (t) => {
  const releaseShutdown = deferred();
  const shutdownStarted = deferred();
  const server = createControlServer({
    pipePath: uniquePipePath('shutdown'),
    handlers: {
      status: async () => ({ state: 'LISTENING' }),
      say: async () => ({}),
      interrupt: async () => ({}),
      shutdown: async () => {
        shutdownStarted.resolve();
        await releaseShutdown.promise;
        return { stopping: true };
      },
    },
  });
  t.after(() => server.close());
  await server.start();

  const first = requestControl({ pipePath: server.pipePath, command: 'shutdown' });
  await shutdownStarted.promise;
  await assert.rejects(
    () => requestControl({ pipePath: server.pipePath, command: 'status' }),
    (error) => error.code === 'shutting_down',
  );
  releaseShutdown.resolve();
  assert.deepEqual(await first, { stopping: true });
});

test('prevents a second daemon control server from binding the same pipe', async (t) => {
  const pipePath = uniquePipePath('single-instance');
  const handlers = {
    status: async () => ({}), say: async () => ({}), interrupt: async () => ({}), shutdown: async () => ({}),
  };
  const first = createControlServer({ pipePath, handlers });
  const second = createControlServer({ pipePath, handlers });
  t.after(async () => { await second.close(); await first.close(); });
  await first.start();

  await assert.rejects(() => second.start(), (error) => error.code === 'EADDRINUSE');
});

test('parses voxtral control commands without an interactive prompt', () => {
  assert.deepEqual(parseControlCommand(['status']), { command: 'status', params: {} });
  assert.deepEqual(parseControlCommand(['say', 'hello', 'there']), {
    command: 'say',
    params: { text: 'hello there' },
  });
  assert.deepEqual(parseControlCommand(['interrupt']), { command: 'interrupt', params: {} });
  assert.deepEqual(parseControlCommand(['stop']), { command: 'shutdown', params: {} });
  assert.throws(() => parseControlCommand(['say']), /text/i);
  assert.throws(() => parseControlCommand(['unknown']), /status.*say.*interrupt.*stop/i);
});

function uniquePipePath(label) {
  return `\\\\.\\pipe\\voxtral-daemon-test-${process.pid}-${label}-${Date.now()}`;
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
