import { createCancellationManager } from './cancellation.mjs';
import { toSpeechText } from './delegation.mjs';

export const SESSION_STATES = Object.freeze({
  IDLE: 'IDLE',
  LISTENING: 'LISTENING',
  THINKING: 'THINKING',
  SPEAKING: 'SPEAKING',
  INTERRUPTED: 'INTERRUPTED',
  ERROR: 'ERROR',
});

export function createConversationSession({
  conversationId,
  audioBackend,
  transcriber,
  turnController,
  vad,
  streamChat,
  speak,
  emit = () => {},
  idFactory = createSequenceIdFactory(),
  audioProfile = 'headset',
  echoCancellation = false,
  isPlaybackEcho = () => false,
  cancellation = createCancellationManager(),
  delegation,
} = {}) {
  validateDependencies({ audioBackend, transcriber, turnController, vad, streamChat, speak, emit, idFactory });
  validateDelegation(delegation);
  validateAudioProfile(audioProfile, echoCancellation, isPlaybackEcho);

  const id = conversationId ?? idFactory('c');
  const history = [];
  const subscriptions = [];
  const tasks = new Set();
  let state = SESSION_STATES.IDLE;
  let activeTurn;
  let started = false;
  let closing = false;

  return { start, status, say, interrupt, shutdown };

  async function start() {
    if (started) return;
    if (closing) throw new Error('conversation session is closing');
    started = true;
    subscriptions.push(
      transcriber.on('partial', ({ text }) => turnController.pushPartial(text)),
      transcriber.on('final', handleFinalTranscript),
      transcriber.on('error', (error) => handleProviderError(error)),
      turnController.on('turn', ({ text }) => startAssistantTurn(text)),
    );
    await transcriber.connect();
    await audioBackend.startInput(handleAudioFrame);
    transition(SESSION_STATES.LISTENING);
    publish({ event: 'listening' });
  }

  function status() {
    return {
      conversationId: id,
      state,
      turnId: activeTurn?.turnId,
      generationId: activeTurn?.generationId,
    };
  }

  function handleAudioFrame(frame) {
    if (closing) return;
    if ((state === SESSION_STATES.SPEAKING || state === SESSION_STATES.THINKING)
        && audioProfile === 'speaker'
        && isPlaybackEcho(frame)) {
      vad.reset();
      return;
    }
    const activity = vad.push(frame);
    if (activity.speechStarted) {
      if (state === SESSION_STATES.SPEAKING || state === SESSION_STATES.THINKING) {
        bargeIn();
      } else if (state === SESSION_STATES.LISTENING) {
        beginUserTurn();
      }
    }
    transcriber.pushAudio(frame);
  }

  function handleFinalTranscript({ text, turnId, generationId }) {
    if (closing || typeof text !== 'string' || !text.trim()) return;
    if (!activeTurn
        || turnId !== activeTurn.turnId
        || generationId !== activeTurn.generationId) return;
    publish({ event: 'user_transcript', text: text.trim(), final: true }, activeTurn);
    turnController.pushFinal(text);
  }

  function beginUserTurn(preallocated) {
    const turn = preallocated ?? allocateTurn();
    activeTurn = turn;
    cancellation.begin(turn);
    transcriber.beginTurn(turn);
    delegation?.beginTurn(turn.turnId);
    transition(SESSION_STATES.LISTENING);
    publish({ event: 'user_started' }, turn);
    return turn;
  }

  function allocateTurn() {
    return { turnId: idFactory('t'), generationId: idFactory('g') };
  }

  function bargeIn() {
    const previous = activeTurn;
    const next = allocateTurn();
    transition(SESSION_STATES.INTERRUPTED);
    audioBackend.stopOutput();
    cancellation.cancel('barge_in');
    turnController.reset();
    publish({
      event: 'barge_in',
      turnId: previous?.turnId,
      generationId: previous?.generationId,
      newTurnId: next.turnId,
      newGenerationId: next.generationId,
    });
    if (previous) publish({ event: 'assistant_cancelled', reason: 'barge_in' }, previous);
    beginUserTurn(next);
  }

  function startAssistantTurn(text) {
    if (closing || !activeTurn || typeof text !== 'string' || !text.trim()) return;
    const scope = cancellation.current();
    if (!cancellation.isCurrent(scope)) return;
    history.push({ role: 'user', content: text.trim() });
    transition(SESSION_STATES.THINKING);
    publish({ event: 'assistant_started' }, scope);
    track(runGeneration(scope));
  }

  async function runGeneration(scope) {
    let assistantText = '';
    let audioStarted = false;
    let speechQueue = Promise.resolve();
    const delegatedResults = [];
    const citations = [];
    const enqueueSpeech = (text) => {
      const speechText = toSpeechText(text);
      if (!speechText) return;
      speechQueue = speechQueue.then(async () => {
        if (!cancellation.isCurrent(scope)) return;
        if (!audioStarted) {
          audioStarted = true;
          transition(SESSION_STATES.SPEAKING);
          publish({ event: 'assistant_audio_started' }, scope);
        }
        await speak({ text: speechText, signal: scope.signal, ...scope });
      });
    };
    try {
      for await (const event of streamChat({ messages: [...history], signal: scope.signal, ...scope })) {
        if (!cancellation.isCurrent(scope)) return;
        if (event?.event === 'delta' && typeof event.text === 'string') {
          assistantText += event.text;
          publish({ event: 'assistant_text_delta', text: event.text }, scope);
        } else if (event?.event === 'sentence_ready' && typeof event.text === 'string' && event.text.trim()) {
          enqueueSpeech(event.text);
        } else if (event?.event === 'tool_call') {
          if (event.name !== 'web_search' || !delegation) {
            const error = new Error('Unsupported conversation tool call');
            error.code = 'unsupported_tool_call';
            throw error;
          }
          const delegated = delegation.delegateWebSearch({
            turnId: scope.turnId,
            signal: scope.signal,
            ...event.arguments,
          });
          enqueueSpeech(delegated.acknowledgement);
          delegatedResults.push(delegated.result);
        }
      }
      await speechQueue;
      for (const pending of delegatedResults) {
        const delegated = await pending;
        if (!cancellation.isCurrent(scope)) return;
        if (delegated.status !== 'completed') continue;
        citations.push(...delegated.citations);
        const summary = delegated.results
          .map(({ title, snippet }) => `${title}. ${snippet}`)
          .join(' ')
          .trim();
        if (summary) {
          assistantText = [assistantText.trim(), summary].filter(Boolean).join(' ');
          enqueueSpeech(summary);
        }
      }
      await speechQueue;
      if (audioStarted) await audioBackend.flushOutput();
      if (!cancellation.isCurrent(scope)) return;
      if (assistantText.trim()) history.push({ role: 'assistant', content: assistantText.trim() });
      publish({ event: 'assistant_final', text: assistantText.trim(), citations }, scope);
      transition(SESSION_STATES.LISTENING);
      publish({ event: 'listening' }, scope);
    } catch (error) {
      if (scope.signal.aborted || !cancellation.isCurrent(scope)) return;
      transition(SESSION_STATES.ERROR);
      publish({
        event: 'error',
        code: safeErrorCode(error?.code),
        message: 'Conversation provider failed',
        recoverable: true,
      }, scope);
      transition(SESSION_STATES.LISTENING);
      publish({ event: 'listening' }, scope);
    }
  }

  async function say(text) {
    if (typeof text !== 'string' || !text.trim()) throw new TypeError('say text is required');
    const speechText = toSpeechText(text);
    if (!speechText) throw new TypeError('say text must include speakable content');
    interrupt('say');
    const scope = beginSyntheticTurn();
    publish({ event: 'assistant_started' }, scope);
    transition(SESSION_STATES.SPEAKING);
    publish({ event: 'assistant_audio_started' }, scope);
    const task = (async () => {
      try {
        await speak({ text: speechText, signal: scope.signal, ...scope });
        await audioBackend.flushOutput();
        if (!cancellation.isCurrent(scope)) return;
        publish({ event: 'assistant_final', text: text.trim(), citations: [] }, scope);
        transition(SESSION_STATES.LISTENING);
        publish({ event: 'listening' }, scope);
      } catch (error) {
        if (!scope.signal.aborted) handleProviderError(error, scope);
      }
    })();
    track(task);
    return { accepted: true, turnId: scope.turnId, generationId: scope.generationId };
  }

  function beginSyntheticTurn() {
    const turn = allocateTurn();
    activeTurn = turn;
    const scope = cancellation.begin(turn);
    delegation?.beginTurn(turn.turnId);
    transition(SESSION_STATES.THINKING);
    return scope;
  }

  function interrupt(reason = 'control') {
    const previous = activeTurn;
    if (!previous || ![SESSION_STATES.THINKING, SESSION_STATES.SPEAKING].includes(state)) {
      return { interrupted: false };
    }
    transition(SESSION_STATES.INTERRUPTED);
    audioBackend.stopOutput();
    cancellation.cancel(reason);
    publish({ event: 'assistant_cancelled', reason }, previous);
    transition(SESSION_STATES.LISTENING);
    publish({ event: 'listening' }, previous);
    return { interrupted: true, turnId: previous.turnId, generationId: previous.generationId };
  }

  async function shutdown() {
    if (closing) return;
    closing = true;
    cancellation.cancel('shutdown');
    delegation?.shutdown();
    audioBackend.stopOutput();
    turnController.reset();
    for (const unsubscribe of subscriptions.splice(0)) unsubscribe?.();
    await Promise.allSettled([transcriber.close(), audioBackend.close(), ...tasks]);
    transition(SESSION_STATES.IDLE);
  }

  function handleProviderError(error, scope = activeTurn) {
    if (closing || (scope?.signal && scope.signal.aborted)) return;
    transition(SESSION_STATES.ERROR);
    publish({
      event: 'error',
      code: safeErrorCode(error?.code),
      message: 'Conversation provider failed',
      recoverable: true,
    }, scope);
    transition(SESSION_STATES.LISTENING);
  }

  function track(task) {
    tasks.add(task);
    task.finally(() => tasks.delete(task));
  }

  function transition(nextState) {
    state = nextState;
  }

  function publish(event, turn = undefined) {
    const context = turn ?? {};
    emit({
      ...event,
      conversationId: id,
      ...(context.turnId && event.turnId === undefined ? { turnId: context.turnId } : {}),
      ...(context.generationId && event.generationId === undefined ? { generationId: context.generationId } : {}),
    });
  }
}

function createSequenceIdFactory() {
  const sequences = new Map();
  return (prefix) => {
    const next = (sequences.get(prefix) ?? 0) + 1;
    sequences.set(prefix, next);
    return `${prefix}_${next.toString(36)}`;
  };
}

function validateDependencies(dependencies) {
  const methods = {
    audioBackend: ['startInput', 'stopOutput', 'flushOutput', 'close'],
    transcriber: ['connect', 'beginTurn', 'pushAudio', 'on', 'close'],
    turnController: ['pushPartial', 'pushFinal', 'on', 'reset'],
    vad: ['push', 'reset'],
  };
  for (const [name, required] of Object.entries(methods)) {
    if (!dependencies[name] || required.some((method) => typeof dependencies[name][method] !== 'function')) {
      throw new TypeError(`${name} does not implement the required interface`);
    }
  }
  for (const name of ['streamChat', 'speak', 'emit', 'idFactory']) {
    if (typeof dependencies[name] !== 'function') throw new TypeError(`${name} must be a function`);
  }
}

function validateAudioProfile(audioProfile, echoCancellation, isPlaybackEcho) {
  if (!['headset', 'speaker'].includes(audioProfile)) throw new TypeError('audioProfile must be headset or speaker');
  if (audioProfile === 'speaker' && echoCancellation !== true) {
    throw new Error('speaker mode requires echo cancellation');
  }
  if (typeof isPlaybackEcho !== 'function') throw new TypeError('isPlaybackEcho must be a function');
}

function validateDelegation(delegation) {
  if (delegation === undefined) return;
  const required = ['beginTurn', 'delegateWebSearch', 'invalidateTurn', 'shutdown'];
  if (!delegation || required.some((method) => typeof delegation[method] !== 'function')) {
    throw new TypeError('delegation does not implement the required interface');
  }
}

function safeErrorCode(code) {
  return typeof code === 'string' && /^[a-z0-9_-]{1,64}$/i.test(code) ? code : 'provider_error';
}
