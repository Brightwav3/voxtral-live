import test from 'node:test';
import assert from 'node:assert/strict';

import { streamChat } from '../src/providers/mistral-chat.mjs';

test('streams text deltas and sentence-ready events from the chat endpoint', async () => {
  let request;
  const events = [];
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(
        'data: {"choices":[{"delta":{"content":"Hello there. "}}]}\n\n'
        + 'data: {"choices":[{"delta":{"content":"How are you?"}}]}\n\n'
        + 'data: [DONE]\n\n',
      ));
      controller.close();
    },
  });

  for await (const event of streamChat({
    apiKey: 'test-key',
    messages: [{ role: 'user', content: 'Hi' }],
    fetchImpl: async (url, options) => {
      request = { url, options };
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    },
  })) events.push(event);

  assert.equal(request.url, 'https://api.mistral.ai/v1/chat/completions');
  assert.equal(request.options.headers.Authorization, 'Bearer test-key');
  assert.deepEqual(JSON.parse(request.options.body), {
    model: 'mistral-small-latest',
    stream: true,
    messages: [
      { role: 'system', content: 'Reply with short, natural sentences. Do not use Markdown.' },
      { role: 'user', content: 'Hi' },
    ],
  });
  assert.deepEqual(events, [
    { event: 'delta', text: 'Hello there. ' },
    { event: 'sentence_ready', text: 'Hello there.' },
    { event: 'delta', text: 'How are you?' },
    { event: 'sentence_ready', text: 'How are you?' },
  ]);
});

test('throws a recoverable sanitized error when the provider rejects the request', async () => {
  const events = streamChat({
    apiKey: 'test-key',
    messages: [{ role: 'user', content: 'Hi' }],
    fetchImpl: async () => new Response(JSON.stringify({ message: 'test-key is invalid' }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    }),
  });

  await assert.rejects(async () => {
    for await (const event of events) void event;
  }, (error) => error.code === 'chat_request_failed'
    && error.recoverable === true
    && error.message === 'Mistral chat request failed'
    && !error.message.includes('test-key'));
});

test('keeps the latest twelve turns and summarizes older history over the token budget', async () => {
  let body;
  const messages = Array.from({ length: 14 }, (_, index) => [
    { role: 'user', content: `Question ${index} ${'x'.repeat(400)}` },
    { role: 'assistant', content: `Answer ${index} ${'y'.repeat(400)}` },
  ]).flat();

  for await (const event of streamChat({
    apiKey: 'test-key',
    messages,
    fetchImpl: async (_url, options) => {
      body = JSON.parse(options.body);
      return new Response(new ReadableStream({
        start(controller) { controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n')); controller.close(); },
      }), { status: 200 });
    },
  })) void event;

  assert.equal(body.messages.at(-1).content.startsWith('Answer 13'), true);
  assert.equal(body.messages.some((message) => message.content.startsWith('Question 2 ')), true);
  assert.equal(body.messages.some((message) => message.content.startsWith('Question 1 ')), false);
  assert.equal(body.messages.some((message) => message.content.startsWith('Conversation summary:')), true);
});
