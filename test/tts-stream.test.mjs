import test from 'node:test';
import assert from 'node:assert/strict';

import { streamSpeech } from '../src/providers/mistral-tts-stream.mjs';

test('streams decoded PCM chunks from SSE events split across arbitrary byte boundaries', async () => {
  let request;
  const encoded = new TextEncoder();
  const source = [
    'data: {"audio_data":"AQI',
    '="}\n\n',
    'data: {"audio_data":"AwQ="}\n\n',
    'data: [DONE]\n\n',
  ];
  const body = streamFrom(source.map((part) => encoded.encode(part)));
  const chunks = [];

  for await (const chunk of streamSpeech({
    apiKey: 'test-key',
    input: 'Ahoj',
    voiceId: 'voice-1',
    fetchImpl: async (url, options) => {
      request = { url, options };
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    },
  })) chunks.push([...chunk]);

  assert.equal(request.url, 'https://api.mistral.ai/v1/audio/speech');
  assert.equal(request.options.headers.Authorization, 'Bearer test-key');
  assert.deepEqual(JSON.parse(request.options.body), {
    model: 'voxtral-mini-tts-latest',
    input: 'Ahoj',
    voice_id: 'voice-1',
    response_format: 'pcm',
    stream: true,
  });
  assert.deepEqual(chunks, [[1, 2], [3, 4]]);
});

test('aborting streaming speech stops iteration before later audio reaches writeOutput', async () => {
  const controller = new AbortController();
  const written = [];
  let releaseSecondEvent;
  const secondEvent = new Promise((resolve) => { releaseSecondEvent = resolve; });
  const body = new ReadableStream({
    async start(streamController) {
      streamController.enqueue(new TextEncoder().encode('data: {"audio_data":"AQI="}\n\n'));
      await secondEvent;
      streamController.enqueue(new TextEncoder().encode('data: {"audio_data":"AwQ="}\n\n'));
      streamController.close();
    },
  });

  for await (const chunk of streamSpeech({
    apiKey: 'test-key',
    input: 'Stop after this',
    signal: controller.signal,
    fetchImpl: async () => new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
  })) {
    written.push([...chunk]);
    controller.abort();
    releaseSecondEvent();
  }

  assert.deepEqual(written, [[1, 2]]);
});

test('returns structured secret-safe errors for provider failures and malformed events', async () => {
  const rejected = streamSpeech({
    apiKey: 'test-key',
    input: 'Test',
    fetchImpl: async () => new Response('provider says Bearer test-key is invalid', { status: 401 }),
  });
  await assert.rejects(collect(rejected), (error) => error.code === 'tts_request_failed'
    && error.recoverable === true
    && error.message === 'Mistral TTS request failed'
    && !error.message.includes('test-key'));

  const malformed = streamSpeech({
    apiKey: 'test-key',
    input: 'Test',
    fetchImpl: async () => new Response(streamFrom([new TextEncoder().encode('data: {not json}\n\n')]), { status: 200 }),
  });
  await assert.rejects(collect(malformed), (error) => error.code === 'invalid_stream'
    && error.recoverable === true
    && error.message === 'Mistral TTS stream failed'
    && !error.message.includes('test-key'));
});

async function collect(stream) {
  for await (const chunk of stream) void chunk;
}

function streamFrom(chunks) {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}
