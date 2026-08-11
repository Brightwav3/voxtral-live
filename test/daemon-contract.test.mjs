import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { resolve } from 'node:path';

import { loadConfig } from '../src/config.mjs';
import { emitEvent } from '../src/events.mjs';
import { startDaemon } from '../src/daemon.mjs';

test('rejects a missing MISTRAL_API_KEY', () => {
  assert.throws(
    () => loadConfig({ MISTRAL_API_KEY: '   ' }),
    /MISTRAL_API_KEY is required/,
  );
});

test('rejects an invalid daemon mode', () => {
  assert.throws(
    () => loadConfig({ MISTRAL_API_KEY: 'test-key', VOXTRAL_MODE: 'sometimes' }),
    /VOXTRAL_MODE must be always-on or push-to-talk/,
  );
});

test('rejects bare --mode with a structured CLI error', () => {
  assert.throws(
    () => loadConfig({ MISTRAL_API_KEY: 'test-key', VOXTRAL_MODE: 'push-to-talk' }, ['--mode']),
    (error) => error.code === 'ERR_INVALID_CLI_ARGUMENT'
      && error.argument === '--mode'
      && error.reason === 'missing_value',
  );
});

test('loads the default daemon configuration', () => {
  assert.deepEqual(loadConfig({ MISTRAL_API_KEY: 'test-key' }), {
    apiKey: 'test-key',
    mode: 'always-on',
    sttModel: 'voxtral-mini-transcribe-realtime-2602',
    sttDelayMs: 240,
    llmModel: 'mistral-small-latest',
    ttsModel: 'voxtral-mini-tts-latest',
    voiceId: undefined,
    inputDevice: undefined,
    outputDevice: undefined,
    audioProfile: 'headset',
    echoCancellation: false,
    sampleRate: 16000,
    frameMs: 20,
  });
});

test('loads optional PortAudio device IDs from CLI flags', () => {
  assert.deepEqual(
    loadConfig({ MISTRAL_API_KEY: 'test-key' }, ['--input-device', '2', '--output-device=7']),
    {
      apiKey: 'test-key',
      mode: 'always-on',
      sttModel: 'voxtral-mini-transcribe-realtime-2602',
      sttDelayMs: 240,
      llmModel: 'mistral-small-latest',
      ttsModel: 'voxtral-mini-tts-latest',
      voiceId: undefined,
      inputDevice: 2,
      outputDevice: 7,
      audioProfile: 'headset',
      echoCancellation: false,
      sampleRate: 16000,
      frameMs: 20,
    },
  );
});

test('requires explicit echo cancellation for speaker mode', () => {
  assert.throws(
    () => loadConfig({ MISTRAL_API_KEY: 'test-key' }, ['--audio-profile', 'speaker']),
    /speaker mode requires --echo-cancel/i,
  );
  assert.equal(
    loadConfig({ MISTRAL_API_KEY: 'test-key' }, ['--audio-profile=speaker', '--echo-cancel']).echoCancellation,
    true,
  );
});

test('emits JSONL events without secret values', () => {
  const lines = [];
  emitEvent({
    event: 'error',
    message: 'request failed with test-key',
    apiKey: 'test-key',
    nested: { authorization: 'Bearer test-key' },
  }, (line) => lines.push(line));

  assert.equal(lines.length, 1);
  assert.doesNotMatch(lines[0], /test-key|Bearer/);
  assert.deepEqual(JSON.parse(lines[0]), {
    event: 'error',
    message: 'request failed with [REDACTED]',
    apiKey: '[REDACTED]',
    nested: { authorization: '[REDACTED]' },
  });
});

test('runs the daemon entrypoint and emits JSONL to stdout', async () => {
  const child = spawn(process.execPath, [resolve('src/daemon.mjs'), '--once'], {
    cwd: process.cwd(),
    env: { ...process.env, MISTRAL_API_KEY: 'smoke-key' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output = [];
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    output.push(...chunk.split('\n').filter(Boolean));
  });

  const [exitCode] = await once(child, 'close');
  assert.equal(exitCode, 0);
  assert.deepEqual(output.map((line) => JSON.parse(line).event), ['daemon_started', 'listening']);
  assert.doesNotMatch(output.join('\n'), /smoke-key/);
});

test('wires injected audio, transcription, chat, speech, and control interfaces', async () => {
  const lines = [];
  const spoken = [];
  const releaseManualSpeech = deferred();
  const transcriber = createEmitter({
    async connect() {},
    beginTurn(turn) { transcriber.turn = turn; },
    pushAudio() { return true; },
    async close() {},
  });
  const turnController = createEmitter({
    pushPartial() {},
    pushFinal(text) { turnController.emit('turn', { text }); },
    reset() {},
  });
  let input;
  let controlHandlers;
  const runtime = startDaemon({
    env: { MISTRAL_API_KEY: 'test-key' },
    write: (line) => lines.push(JSON.parse(line)),
    dependencies: {
      audioBackend: {
        async startInput(handler) { input = handler; },
        writeOutput() {}, stopOutput() {}, async flushOutput() {}, async close() {},
      },
      vad: { push: (frame) => ({ speechStarted: frame.speechStarted }), reset() {} },
      transcriber,
      turnController,
      async *streamChat() {
        yield { event: 'delta', text: 'Connected.' };
        yield { event: 'sentence_ready', text: 'Connected.' };
      },
      async speak({ text }) {
        spoken.push(text);
        if (text === 'Manual speech') await releaseManualSpeech.promise;
      },
      searchProvider: { async search() { return []; } },
      controlServerFactory(options) {
        controlHandlers = options.handlers;
        return { pipePath: 'test-pipe', async start() {}, async close() {} };
      },
    },
  });
  await runtime.ready;

  input({ speechStarted: true });
  transcriber.emit('final', { text: 'Hello daemon', ...transcriber.turn });
  await waitFor(() => lines.some((event) => event.event === 'assistant_final'));

  assert.deepEqual(spoken, ['Connected.']);
  assert.equal((await controlHandlers.status()).state, 'LISTENING');
  assert.equal((await controlHandlers.say({ text: 'Manual speech' })).accepted, true);
  assert.equal(controlHandlers.interrupt().interrupted, true);
  releaseManualSpeech.resolve();
  await runtime.shutdown();
  assert.equal(lines.at(-1).event, 'daemon_stopped');
});

test('acquires singleton ownership before STT/mic and emits daemon_started last', async () => {
  const order = [];
  const transcriber = createEmitter({
    async connect() { order.push('stt'); }, beginTurn() {}, pushAudio() { return true; }, async close() {},
  });
  const runtime = startDaemon({
    env: { MISTRAL_API_KEY: 'test-key' },
    write(line) {
      if (JSON.parse(line).event === 'daemon_started') order.push('daemon_started');
    },
    dependencies: {
      audioBackend: {
        async startInput() { order.push('mic'); }, writeOutput() {}, stopOutput() {},
        async flushOutput() {}, async close() {},
      },
      vad: { push: () => ({ speechStarted: false }), reset() {} },
      transcriber,
      turnController: createEmitter({ pushPartial() {}, pushFinal() {}, reset() {} }),
      async *streamChat() {}, async speak() {},
      searchProvider: { async search() { return []; } },
      controlServerFactory() {
        return { pipePath: 'test-pipe', async start() { order.push('singleton'); }, async close() {} };
      },
    },
  });

  await runtime.ready;
  assert.deepEqual(order, ['singleton', 'stt', 'mic', 'daemon_started']);
  await runtime.shutdown();
});

test('singleton bind failure starts neither STT nor microphone and emits no started event', async () => {
  const calls = [];
  const lines = [];
  const bindError = Object.assign(new Error('occupied'), { code: 'EADDRINUSE' });
  const runtime = startDaemon({
    env: { MISTRAL_API_KEY: 'test-key' },
    write: (line) => lines.push(JSON.parse(line)),
    dependencies: {
      audioBackend: {
        async startInput() { calls.push('mic'); }, writeOutput() {}, stopOutput() {},
        async flushOutput() {}, async close() {},
      },
      vad: { push: () => ({ speechStarted: false }), reset() {} },
      transcriber: createEmitter({
        async connect() { calls.push('stt'); }, beginTurn() {}, pushAudio() { return true; }, async close() {},
      }),
      turnController: createEmitter({ pushPartial() {}, pushFinal() {}, reset() {} }),
      async *streamChat() {}, async speak() {},
      searchProvider: { async search() { return []; } },
      controlServerFactory() {
        return { pipePath: 'test-pipe', async start() { throw bindError; }, async close() {} };
      },
    },
  });

  await assert.rejects(() => runtime.ready, (error) => error.code === 'EADDRINUSE');
  assert.deepEqual(calls, []);
  assert.equal(lines.some((event) => event.event === 'daemon_started'), false);
});

test('shutdown control handshake resolves only after audio and STT cleanup', async () => {
  const cleanup = deferred();
  let handlers;
  const runtime = startDaemon({
    env: { MISTRAL_API_KEY: 'test-key' },
    write() {},
    dependencies: {
      audioBackend: {
        async startInput() {}, writeOutput() {}, stopOutput() {}, async flushOutput() {},
        async close() { await cleanup.promise; },
      },
      vad: { push: () => ({ speechStarted: false }), reset() {} },
      transcriber: createEmitter({ async connect() {}, beginTurn() {}, pushAudio() { return true; }, async close() {} }),
      turnController: createEmitter({ pushPartial() {}, pushFinal() {}, reset() {} }),
      async *streamChat() {}, async speak() {},
      searchProvider: { async search() { return []; } },
      controlServerFactory(options) {
        handlers = options.handlers;
        return { pipePath: 'test-pipe', async start() {}, async close() {} };
      },
    },
  });
  await runtime.ready;
  let acknowledged = false;

  const stopping = handlers.shutdown().then((result) => { acknowledged = true; return result; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(acknowledged, false);
  cleanup.resolve();
  assert.deepEqual(await stopping, { stopped: true });
});

function createEmitter(methods) {
  const handlers = new Map();
  return {
    ...methods,
    on(eventName, handler) {
      const listeners = handlers.get(eventName) ?? new Set();
      listeners.add(handler);
      handlers.set(eventName, listeners);
      return () => listeners.delete(handler);
    },
    emit(eventName, event) {
      for (const handler of handlers.get(eventName) ?? []) handler(event);
    },
  };
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail('timed out waiting for daemon event');
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
