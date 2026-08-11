import test from 'node:test';
import assert from 'node:assert/strict';

import { createServer } from '../src/server.mjs';

async function withServer(fetchImpl, callback) {
  const server = createServer({ apiKey: 'test-key', fetchImpl });
  await new Promise((resolve) => server.listen(0, resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    return await callback(baseUrl);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test('serves a health response', async () => {
  await withServer(async () => {
    throw new Error('Mistral must not be called');
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/health`);

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
  });
});

test('serves the Voxtral Studio product shell', async () => {
  await withServer(async () => {
    throw new Error('Mistral must not be called');
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/`);

    assert.equal(response.status, 200);
    assert.match(await response.text(), /Voxtral Studio/);
  });
});

test('lists Mistral voices through the product API', async () => {
  await withServer(async (url) => {
    assert.match(url, /\/v1\/audio\/voices/);
    return new Response(JSON.stringify({ data: [{ id: 'voice-1', name: 'Paul Neutral' }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/voices`);

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      data: [{ id: 'voice-1', name: 'Paul Neutral' }],
    });
  });
});

test('normalizes the live voices response from items to data', async () => {
  await withServer(async () => new Response(JSON.stringify({
    items: [{ id: 'voice-2', name: 'Oliver Neutral' }],
    total: 1,
  }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  }), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/voices`);

    assert.deepEqual(await response.json(), {
      data: [{ id: 'voice-2', name: 'Oliver Neutral' }],
      total: 1,
    });
  });
});

test('generates TTS audio through the product API', async () => {
  await withServer(async (url, options) => {
    assert.match(url, /\/v1\/audio\/speech/);
    assert.equal(JSON.parse(options.body).input, 'Hello');
    return new Response(JSON.stringify({ audio_data: 'SGVsbG8=' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/tts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Hello', voiceId: 'voice-1', format: 'mp3' }),
    });

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'audio/mpeg');
    assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [72, 101, 108, 108, 111]);
  });
});

test('transcribes an uploaded audio file through the product API', async () => {
  await withServer(async (url, options) => {
    assert.match(url, /\/v1\/audio\/transcriptions/);
    const uploaded = options.body.get('file');
    assert.equal(uploaded.name, 'sample.wav');
    return new Response(JSON.stringify({ text: 'Ahoj ze serveru.' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }, async (baseUrl) => {
    const form = new FormData();
    form.append('file', new Blob([Buffer.from([1, 2, 3])], { type: 'audio/wav' }), 'sample.wav');
    form.append('language', 'cs');

    const response = await fetch(`${baseUrl}/api/transcribe`, {
      method: 'POST',
      body: form,
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { text: 'Ahoj ze serveru.' });
  });
});
