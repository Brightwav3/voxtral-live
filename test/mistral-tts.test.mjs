import test from 'node:test';
import assert from 'node:assert/strict';

import { encodeAudioFile, synthesizeSpeech } from '../src/mistral-tts.mjs';

test('encodes a reference audio file as Base64', async () => {
  const encoded = await encodeAudioFile('voice.mp3', async () => Buffer.from([1, 2, 3]));

  assert.equal(encoded, 'AQID');
});

test('sends the TTS request and decodes returned audio', async () => {
  let request;

  const response = await synthesizeSpeech({
    apiKey: 'test-key',
    input: 'Ahoj, světe.',
    voiceId: 'preset-voice',
    responseFormat: 'mp3',
    fetchImpl: async (url, options) => {
      request = { url, options };
      return new Response(JSON.stringify({ audio_data: 'SGVsbG8=' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });

  assert.equal(request.url, 'https://api.mistral.ai/v1/audio/speech');
  assert.equal(request.options.headers.Authorization, 'Bearer test-key');
  assert.deepEqual(JSON.parse(request.options.body), {
    model: 'voxtral-mini-tts-2603',
    input: 'Ahoj, světe.',
    voice_id: 'preset-voice',
    response_format: 'mp3',
    stream: false,
  });
  assert.deepEqual([...response.audio], [72, 101, 108, 108, 111]);
});

test('rejects an empty text input before making a request', async () => {
  await assert.rejects(
    () => synthesizeSpeech({ apiKey: 'test-key', input: '   ', fetchImpl: async () => {
      throw new Error('fetch must not be called');
    } }),
    /input must not be empty/i,
  );
});

test('surfaces Mistral API errors with their message', async () => {
  await assert.rejects(
    () => synthesizeSpeech({
      apiKey: 'test-key',
      input: 'Test',
      fetchImpl: async () => new Response(JSON.stringify({ message: 'Invalid voice' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      }),
    }),
    /Mistral TTS request failed \(400\): Invalid voice/,
  );
});
