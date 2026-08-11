import test from 'node:test';
import assert from 'node:assert/strict';

import { createConversationSession } from '../src/conversation/session.mjs';
import { createDelegationManager } from '../src/conversation/delegation.mjs';

test('assigns a unique turnId and generationId to every user turn', async () => {
  const subject = createSubject();
  await subject.session.start();

  subject.input({ speechStarted: true, name: 'first' });
  subject.transcriber.emit('final', { text: 'First turn' });
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
  subject.transcriber.emit('final', { text: 'First turn' });
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

  subject.transcriber.emit('final', { text: 'Second turn' });
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
  subject.transcriber.emit('final', { text: 'Start speaking' });
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
  subject.transcriber.emit('final', { text: 'Find updates' });
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

function createSubject(overrides = {}) {
  const events = [];
  const audio = {
    stopOutputCalls: 0,
    async startInput(handler) { audio.input = handler; },
    writeOutput() {},
    stopOutput() { audio.stopOutputCalls += 1; },
    async close() {},
  };
  const transcriber = createEmitter({
    frames: [],
    async connect() {},
    pushAudio(frame) { transcriber.frames.push(frame); return true; },
    async close() {},
  });
  const turnController = createEmitter({
    pushPartial() {},
    pushFinal(text) { turnController.emit('turn', { text }); },
    reset() {},
  });
  const vad = {
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
  return { session, audio, transcriber, turnController, vad, events, input: (frame) => audio.input(frame) };
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
