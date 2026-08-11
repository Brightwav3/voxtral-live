import test from 'node:test';
import assert from 'node:assert/strict';

import { loadConfig } from '../src/config.mjs';
import { createRealtimeTranscriber } from '../src/providers/mistral-realtime-stt.mjs';

class FakeWebSocket {
  static instances = [];

  constructor(url, options) {
    this.url = url;
    this.options = options;
    this.readyState = FakeWebSocket.CONNECTING;
    this.sent = [];
    this.listeners = new Map();
    FakeWebSocket.instances.push(this);
  }

  addEventListener(eventName, handler) {
    const handlers = this.listeners.get(eventName) ?? [];
    handlers.push(handler);
    this.listeners.set(eventName, handlers);
  }

  send(message) {
    if (this.readyState !== FakeWebSocket.OPEN) throw new Error('socket is not open');
    if (this.failNextSend) {
      this.failNextSend = false;
      throw new Error('send failed');
    }
    this.sent.push(message);
  }

  close(code = 1000) {
    this.readyState = FakeWebSocket.CLOSING;
    queueMicrotask(() => this.emit('close', { code }));
  }

  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.emit('open');
  }

  message(payload) {
    this.emit('message', { data: JSON.stringify(payload) });
  }

  emit(eventName, event = {}) {
    if (eventName === 'close') this.readyState = FakeWebSocket.CLOSED;
    for (const handler of this.listeners.get(eventName) ?? []) handler(event);
  }
}

Object.assign(FakeWebSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });

function createSubject() {
  FakeWebSocket.instances = [];
  return createRealtimeTranscriber({
    apiKey: 'test-api-key',
    WebSocketImpl: FakeWebSocket,
  });
}

async function connect(transcriber) {
  const pending = transcriber.connect();
  FakeWebSocket.instances.at(-1).open();
  await pending;
  return FakeWebSocket.instances.at(-1);
}

test('creates a 16 kHz realtime session with the fast default delay', async () => {
  const transcriber = createSubject();
  const socket = await connect(transcriber);

  assert.equal(
    socket.url,
    'wss://api.mistral.ai/v1/audio/transcriptions/realtime?model=voxtral-mini-transcribe-realtime-2602',
  );
  assert.deepEqual(socket.options, { headers: { Authorization: 'Bearer test-api-key' } });
  assert.deepEqual(JSON.parse(socket.sent[0]), {
    type: 'session.update',
    session: {
      audio_format: { encoding: 'pcm_s16le', sample_rate: 16000 },
      target_streaming_delay_ms: 240,
    },
  });
});

test('maps text deltas and complete transcripts without exposing provider payloads', async () => {
  const transcriber = createSubject();
  const events = [];
  for (const eventName of ['partial', 'final', 'session_ready']) {
    transcriber.on(eventName, (event) => events.push(event));
  }
  const socket = await connect(transcriber);
  transcriber.beginTurn({ turnId: 't_9', generationId: 'g_9' });

  socket.message({
    type: 'session.created',
    session: { request_id: 'req_non_secret', ignored: 'raw provider data' },
  });
  socket.message({ type: 'transcription.text.delta', text: 'Hello ' });
  socket.message({ type: 'transcription.done', text: 'Hello world', usage: { secret: 'nope' } });

  assert.deepEqual(events, [
    { event: 'session_ready', requestId: 'req_non_secret' },
    { event: 'partial', text: 'Hello ' },
    { event: 'final', text: 'Hello world', turnId: 't_9', generationId: 'g_9' },
  ]);
});

test('associates the next final with the replacement turn when the interrupted turn has no final', async () => {
  const transcriber = createSubject();
  const finals = [];
  transcriber.on('final', (event) => finals.push(event));
  const socket = await connect(transcriber);
  const interrupted = { turnId: 't_old', generationId: 'g_old' };
  const current = { turnId: 't_current', generationId: 'g_current' };
  transcriber.beginTurn(interrupted);
  transcriber.beginTurn(current, { replaces: interrupted });

  socket.message({ type: 'transcription.done', text: 'Current turn' });

  assert.deepEqual(finals, [{ event: 'final', text: 'Current turn', ...current }]);
});

test('maps provider errors to recoverable sanitized errors', async () => {
  const transcriber = createSubject();
  const errors = [];
  transcriber.on('error', (event) => errors.push(event));
  const socket = await connect(transcriber);

  socket.message({
    type: 'error',
    error: { code: 'invalid_audio', message: 'test-api-key and raw provider details' },
  });

  assert.deepEqual(errors, [{
    event: 'error',
    code: 'invalid_audio',
    message: 'Realtime transcription provider error',
    recoverable: true,
  }]);
});

test('allows reconnecting after an unexpected close but not after explicit shutdown', async () => {
  const transcriber = createSubject();
  const closed = [];
  transcriber.on('closed', (event) => closed.push(event));
  const first = await connect(transcriber);

  first.emit('close', { code: 1006 });
  const second = await connect(transcriber);
  assert.notEqual(second, first);
  assert.deepEqual(closed, [{ event: 'closed', code: 1006, recoverable: true }]);

  await transcriber.close();
  await assert.rejects(() => transcriber.connect(), /closed/i);
  assert.equal(FakeWebSocket.instances.length, 2);
});

test('safely drops audio before open and closes the input stream exactly once', async () => {
  const transcriber = createSubject();
  assert.equal(transcriber.pushAudio(Buffer.from([1, 2])), false);
  const socket = await connect(transcriber);

  assert.equal(transcriber.pushAudio(Buffer.from([1, 2, 3])), true);
  assert.deepEqual(JSON.parse(socket.sent[1]), {
    type: 'input_audio.append',
    audio: 'AQID',
  });

  await transcriber.close();
  assert.deepEqual(JSON.parse(socket.sent[2]), { type: 'input_audio.end' });
});

test('rejects audio when WebSocket bufferedAmount exceeds the bounded cap', async () => {
  const transcriber = createSubject();
  const errors = [];
  transcriber.on('error', (event) => errors.push(event));
  const socket = await connect(transcriber);
  socket.bufferedAmount = 1_048_577;

  assert.equal(transcriber.pushAudio(Buffer.from([1, 2, 3])), false);
  assert.equal(socket.sent.length, 1);
  assert.deepEqual(errors, [{
    event: 'error',
    code: 'backpressure',
    message: 'Realtime transcription provider error',
    recoverable: true,
  }]);
});

test('converts a failed WebSocket send into a recoverable sanitized error', async () => {
  const transcriber = createSubject();
  const errors = [];
  transcriber.on('error', (event) => errors.push(event));
  const socket = await connect(transcriber);
  socket.failNextSend = true;

  assert.equal(transcriber.pushAudio(Buffer.from([4, 5, 6])), false);
  assert.deepEqual(errors, [{
    event: 'error',
    code: 'send_failed',
    message: 'Realtime transcription provider error',
    recoverable: true,
  }]);
});

test('loads --stt-delay-ms and rejects invalid delay values', () => {
  assert.equal(loadConfig({ MISTRAL_API_KEY: 'test-key' }, ['--stt-delay-ms=480']).sttDelayMs, 480);
  assert.throws(
    () => loadConfig({ MISTRAL_API_KEY: 'test-key' }, ['--stt-delay-ms', '0']),
    (error) => error.code === 'ERR_INVALID_CLI_ARGUMENT'
      && error.argument === '--stt-delay-ms'
      && error.reason === 'invalid_value',
  );
});
