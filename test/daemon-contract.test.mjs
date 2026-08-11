import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { resolve } from 'node:path';

import { loadConfig } from '../src/config.mjs';
import { emitEvent } from '../src/events.mjs';

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
      sampleRate: 16000,
      frameMs: 20,
    },
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

test('makes the control placeholder explicit without starting a daemon', async () => {
  const child = spawn(process.execPath, [resolve('src/daemon.mjs'), '--control', 'status'], {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { output += chunk; });

  const [exitCode] = await once(child, 'close');
  assert.equal(exitCode, 2);
  assert.deepEqual(JSON.parse(output), {
    event: 'error',
    code: 'control_not_implemented',
    recoverable: false,
    message: 'Local control is not implemented until Task 8.',
  });
});
