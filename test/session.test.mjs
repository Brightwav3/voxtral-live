import test from 'node:test';
import assert from 'node:assert/strict';

import { createConversationSession } from '../src/conversation/session.mjs';
import { createDelegationManager } from '../src/conversation/delegation.mjs';
import { createVad } from '../src/audio/vad.mjs';
import { createEchoSuppressor } from '../src/audio/echo-suppressor.mjs';

test('assigns a unique turnId and generationId to every user turn', async () => {
  const subject = createSubject();
  await subject.session.start();

  subject.input({ speechStarted: true, name: 'first' });
  subject.final('First turn');
  await waitFor(() => subject.session.status().state === 'LISTENING');
  subject.input({ speechStarted: true, name: 'second' });

  const turns = subject.events.filter((event) => event.event === 'user_started');
  assert.deepEqual(turns, [
    { event: 'user_started', conversationId: 'conversation-test', turnId: 't_1', generationId: 'g_1' },
    { event: 'user_started', conversationId: 'conversation-test', turnId: 't_2', generationId: 'g_2' },
  ]);
  await subject.session.shutdown();
});

test('barge-in stops output, aborts generation, accepts new audio, and ignores stale completion', async () => {
  const firstSpeech = deferred();
  const speechCalls = [];
  const subject = createSubject({
    async *streamChat({ messages }) {
      const text = messages.at(-1).content === 'First turn' ? 'Old answer.' : 'New answer.';
      yield { event: 'delta', text };
      yield { event: 'sentence_ready', text };
    },
    async speak(call) {
      speechCalls.push(call);
      if (call.text === 'Old answer.') await firstSpeech.promise;
    },
  });
  await subject.session.start();

  subject.input({ speechStarted: true, name: 'first-frame' });
  subject.final('First turn');
  await waitFor(() => subject.session.status().state === 'SPEAKING');
  const firstGeneration = subject.session.status();

  subject.input({ speechStarted: true, name: 'barge-frame' });

  assert.equal(subject.audio.stopOutputCalls, 1);
  assert.equal(speechCalls[0].signal.aborted, true);
  assert.deepEqual(subject.transcriber.frames.map((frame) => frame.name), ['first-frame', 'barge-frame']);
  assert.deepEqual(subject.events.find((event) => event.event === 'barge_in'), {
    event: 'barge_in',
    conversationId: 'conversation-test',
    turnId: firstGeneration.turnId,
    generationId: firstGeneration.generationId,
    newTurnId: 't_2',
    newGenerationId: 'g_2',
  });
  assert.equal(subject.session.status().state, 'LISTENING');
  assert.equal(subject.session.status().turnId, 't_2');

  firstSpeech.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(subject.session.status().turnId, 't_2');
  assert.equal(subject.session.status().state, 'LISTENING');
  assert.equal(subject.events.some((event) => event.event === 'assistant_final' && event.turnId === 't_1'), false);

  subject.final('Second turn');
  await waitFor(() => subject.events.some((event) => event.event === 'assistant_final' && event.turnId === 't_2'));
  assert.equal(speechCalls.at(-1).text, 'New answer.');
  await subject.session.shutdown();
});

test('speaker mode requires echo cancellation and suppresses detected playback echo', async () => {
  assert.throws(
    () => createSubject({ audioProfile: 'speaker', echoCancellation: false }),
    /speaker mode requires echo cancellation/i,
  );

  const holdSpeech = deferred();
  const subject = createSubject({
    audioProfile: 'speaker',
    echoCancellation: true,
    isPlaybackEcho: (frame) => frame.echo === true,
    async *streamChat() {
      yield { event: 'sentence_ready', text: 'Playing.' };
    },
    async speak() { await holdSpeech.promise; },
  });
  await subject.session.start();
  subject.input({ speechStarted: true });
  subject.final('Start speaking');
  await waitFor(() => subject.session.status().state === 'SPEAKING');

  subject.input({ speechStarted: true, echo: true });
  assert.equal(subject.audio.stopOutputCalls, 0);
  assert.equal(subject.session.status().state, 'SPEAKING');

  subject.input({ speechStarted: true, echo: false });
  assert.equal(subject.audio.stopOutputCalls, 1);
  assert.equal(subject.session.status().state, 'LISTENING');
  holdSpeech.resolve();
  await subject.session.shutdown();
});

test('adds delegated search citations to final text while TTS receives no raw URL', async () => {
  const spoken = [];
  let manager;
  const subject = createSubject({
    async *streamChat() {
      yield {
        event: 'tool_call',
        id: 'call_1',
        name: 'web_search',
        arguments: { query: 'Voxtral updates', recencyDays: 7 },
      };
    },
    async speak({ text }) { spoken.push(text); },
    createDelegation({ events }) {
      manager = createDelegationManager({
        conversationId: 'conversation-test',
        emit: (event) => events.push(event),
        webSearch: async () => [{
          title: 'Voxtral docs',
          url: 'https://example.test/voxtral',
          snippet: 'Official release details.',
          publishedAt: '2026-08-10T12:00:00Z',
        }],
      });
      return manager;
    },
  });
  await subject.session.start();
  subject.input({ speechStarted: true });
  subject.final('Find updates');
  await waitFor(() => subject.events.some((event) => event.event === 'assistant_final'));

  assert.deepEqual(spoken, ["I'll look that up.", 'Voxtral docs. Official release details.']);
  assert.equal(spoken.some((text) => text.includes('https://')), false);
  assert.deepEqual(subject.events.find((event) => event.event === 'assistant_final'), {
    event: 'assistant_final',
    conversationId: 'conversation-test',
    turnId: 't_1',
    generationId: 'g_1',
    text: 'Voxtral docs. Official release details.',
    citations: [{
      title: 'Voxtral docs',
      url: 'https://example.test/voxtral',
      publishedAt: '2026-08-10T12:00:00Z',
    }],
  });
  await subject.session.shutdown();
});

test('stays SPEAKING through queued playback tail and routes tail speech through barge-in', async () => {
  const drain = deferred();
  const subject = createSubject({
    async *streamChat() {
      yield { event: 'delta', text: 'Tail audio.' };
      yield { event: 'sentence_ready', text: 'Tail audio.' };
    },
    async flushOutput() { await drain.promise; },
  });
  await subject.session.start();
  subject.input({ speechStarted: true });
  subject.final('Start tail test');
  await waitFor(() => subject.events.some((event) => event.event === 'assistant_audio_started'));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(subject.audio.flushOutputCalls, 1);
  assert.equal(subject.session.status().state, 'SPEAKING');
  subject.input({ speechStarted: true });
  assert.equal(subject.audio.stopOutputCalls, 1);
  assert.equal(subject.events.some((event) => event.event === 'barge_in'), true);

  drain.resolve();
  await subject.session.shutdown();
});

test('sanitizes raw URLs before voxtral say reaches TTS', async () => {
  const spoken = [];
  const subject = createSubject({ async speak({ text }) { spoken.push(text); } });
  await subject.session.start();

  await subject.session.say('Read https://example.test/private now.');
  await waitFor(() => subject.events.some((event) => event.event === 'assistant_final'));

  assert.deepEqual(spoken, ['Read now.']);
  await subject.session.shutdown();
});

test('sustained speaker echo does not latch VAD or hide a later human barge-in', async () => {
  const holdSpeech = deferred();
  const suppressor = createEchoSuppressor({ correlationThreshold: 0.8 });
  suppressor.pushOutput(signalFrame(24_000, 480, 440));
  const subject = createSubject({
    audioProfile: 'speaker',
    echoCancellation: true,
    vad: createVad({ startRms: 0.05, stopRms: 0.03 }),
    isPlaybackEcho: suppressor.isPlaybackEcho,
    async *streamChat() { yield { event: 'sentence_ready', text: 'Playing.' }; },
    async speak() { await holdSpeech.promise; },
  });
  await subject.session.start();
  for (let index = 0; index < 3; index += 1) subject.input(toPcm16(signalFrame(16_000, 320, 910)));
  subject.final('Start playback');
  await waitFor(() => subject.session.status().state === 'SPEAKING');

  for (let index = 0; index < 6; index += 1) subject.input(toPcm16(signalFrame(16_000, 320, 440)));
  assert.equal(subject.audio.stopOutputCalls, 0);
  for (let index = 0; index < 3; index += 1) subject.input(toPcm16(signalFrame(16_000, 320, 910)));

  assert.equal(subject.audio.stopOutputCalls, 1);
  assert.equal(subject.events.some((event) => event.event === 'barge_in'), true);
  holdSpeech.resolve();
  await subject.session.shutdown();
});

test('discards a delayed final STT callback from the pre-barge generation', async () => {
  const holdSpeech = deferred();
  const subject = createSubject({
    async *streamChat() { yield { event: 'sentence_ready', text: 'Speaking.' }; },
    async speak() { await holdSpeech.promise; },
  });
  await subject.session.start();
  subject.input({ speechStarted: true });
  const first = subject.session.status();
  subject.final('First', first);
  await waitFor(() => subject.session.status().state === 'SPEAKING');
  subject.input({ speechStarted: true });
  const second = subject.session.status();

  subject.final('Stale result', first);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(subject.events.some((event) => event.event === 'user_transcript' && event.text === 'Stale result'), false);
  assert.equal(subject.session.status().turnId, second.turnId);

  holdSpeech.resolve();
  await subject.session.shutdown();
});

test('accepts the current final when the interrupted turn never produced a provider final', async () => {
  const holdSpeech = deferred();
  const subject = createSubject({
    async *streamChat() { yield { event: 'sentence_ready', text: 'Speaking.' }; },
    async speak() { await holdSpeech.promise; },
  });
  await subject.session.start();
  subject.input({ speechStarted: true });
  subject.turnController.emit('turn', { text: 'Start without an STT final' });
  await waitFor(() => subject.session.status().state === 'SPEAKING');

  subject.input({ speechStarted: true });
  const current = subject.session.status();
  subject.nextFinal('Current turn');
  await waitFor(() => subject.events.some((event) => event.event === 'user_transcript'));

  assert.deepEqual(
    subject.events.find((event) => event.event === 'user_transcript'),
    {
      event: 'user_transcript',
      text: 'Current turn',
      final: true,
      conversationId: 'conversation-test',
      turnId: current.turnId,
      generationId: current.generationId,
    },
  );
  holdSpeech.resolve();
  await subject.session.shutdown();
});

function createSubject(overrides = {}) {
  const events = [];
  const audio = {
    stopOutputCalls: 0,
    flushOutputCalls: 0,
    async startInput(handler) { audio.input = handler; },
    writeOutput() {},
    stopOutput() { audio.stopOutputCalls += 1; },
    async flushOutput() {
      audio.flushOutputCalls += 1;
      await overrides.flushOutput?.();
    },
    async close() {},
  };
  let transcriberContext;
  const pendingTranscriberTurns = [];
  const transcriber = createEmitter({
    frames: [],
    beginTurn(turn, { replaces } = {}) {
      if (replaces) {
        const index = pendingTranscriberTurns.findIndex((pending) => sameIdentity(pending, replaces));
        if (index !== -1) pendingTranscriberTurns.splice(index, 1);
      }
      transcriberContext = { turnId: turn.turnId, generationId: turn.generationId };
      pendingTranscriberTurns.push(transcriberContext);
    },
    async connect() {},
    pushAudio(frame) { transcriber.frames.push(frame); return true; },
    async close() {},
  });
  const turnController = createEmitter({
    pushPartial() {},
    pushFinal(text) { turnController.emit('turn', { text }); },
    reset() {},
  });
  const vad = overrides.vad ?? {
    push(frame) {
      return { state: frame.speechStarted ? 'speech' : 'silence', speechStarted: frame.speechStarted, speechStopped: false };
    },
    reset() {},
  };
  let sequence = 0;
  const delegation = overrides.createDelegation?.({ events });
  const session = createConversationSession({
    conversationId: 'conversation-test',
    audioBackend: audio,
    transcriber,
    turnController,
    vad,
    emit: (event) => events.push(event),
    idFactory(prefix) { sequence += 1; return `${prefix}_${Math.ceil(sequence / 2)}`; },
    streamChat: overrides.streamChat ?? (async function* defaultChat() {}),
    speak: overrides.speak ?? (async () => {}),
    audioProfile: overrides.audioProfile,
    echoCancellation: overrides.echoCancellation,
    isPlaybackEcho: overrides.isPlaybackEcho,
    delegation,
  });
  return {
    session,
    audio,
    transcriber,
    turnController,
    vad,
    events,
    input: (frame) => audio.input(frame),
    final(text, context = transcriberContext) {
      const index = pendingTranscriberTurns.findIndex((pending) => sameIdentity(pending, context));
      if (index !== -1) pendingTranscriberTurns.splice(index, 1);
      transcriber.emit('final', { text, ...context });
    },
    nextFinal(text) {
      const context = pendingTranscriberTurns.shift();
      transcriber.emit('final', { text, ...context });
    },
  };
}

function sameIdentity(left, right) {
  return left?.turnId === right?.turnId && left?.generationId === right?.generationId;
}

function signalFrame(sampleRate, length, frequency) {
  return Float32Array.from({ length }, (_, index) => Math.sin(2 * Math.PI * frequency * index / sampleRate) * 0.25);
}

function toPcm16(frame) {
  const buffer = Buffer.alloc(frame.length * 2);
  frame.forEach((sample, index) => buffer.writeInt16LE(Math.round(sample * 32767), index * 2));
  return buffer;
}

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

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail('timed out waiting for session state');
}
