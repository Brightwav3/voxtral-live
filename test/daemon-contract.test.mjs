import test from 'node:test';
import assert from 'node:assert/strict';

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

test('loads the default daemon configuration', () => {
  assert.deepEqual(loadConfig({ MISTRAL_API_KEY: 'test-key' }), {
    apiKey: 'test-key',
    mode: 'always-on',
    sttModel: 'voxtral-mini-transcribe-realtime-2602',
    llmModel: 'mistral-small-latest',
    ttsModel: 'voxtral-mini-tts-latest',
    voiceId: undefined,
    sampleRate: 16000,
    frameMs: 20,
  });
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
