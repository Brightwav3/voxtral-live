import test from 'node:test';
import assert from 'node:assert/strict';

import { transcribeAudio } from '../src/mistral-transcribe.mjs';

test('uploads an audio file and returns the transcription', async () => {
  let request;

  const result = await transcribeAudio({
    apiKey: 'test-key',
    filePath: 'sample.wav',
    language: 'cs',
    fetchImpl: async (url, options) => {
      request = { url, options };
      const form = options.body;
      assert.equal(form.get('model'), 'voxtral-mini-latest');
      assert.equal(form.get('language'), 'cs');
      const uploadedFile = form.get('file');
      assert.equal(uploadedFile.name, 'sample.wav');
      assert.deepEqual(
        [...new Uint8Array(await uploadedFile.arrayBuffer())],
        [1, 2, 3],
      );

      return new Response(JSON.stringify({ text: 'Ahoj, světe.' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
    readFileImpl: async () => Buffer.from([1, 2, 3]),
  });

  assert.equal(request.url, 'https://api.mistral.ai/v1/audio/transcriptions');
  assert.equal(request.options.headers.Authorization, 'Bearer test-key');
  assert.equal(result.text, 'Ahoj, světe.');
});

test('rejects a missing audio path before making a request', async () => {
  await assert.rejects(
    () => transcribeAudio({
      apiKey: 'test-key',
      fetchImpl: async () => {
        throw new Error('fetch must not be called');
      },
    }),
    /filePath is required/i,
  );
});

test('surfaces Mistral transcription errors with their message', async () => {
  await assert.rejects(
    () => transcribeAudio({
      apiKey: 'test-key',
      filePath: 'sample.wav',
      fetchImpl: async () => new Response(JSON.stringify({ message: 'Unsupported audio' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      }),
      readFileImpl: async () => Buffer.from([1]),
    }),
    /Mistral transcription request failed \(400\): Unsupported audio/,
  );
});
