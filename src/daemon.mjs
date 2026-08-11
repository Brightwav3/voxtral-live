import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

import { loadConfig } from './config.mjs';
import { emitEvent } from './events.mjs';
import { createAudioBackend } from './audio/audio-backend.mjs';
import { createVad } from './audio/vad.mjs';
import { createEchoSuppressor } from './audio/echo-suppressor.mjs';
import { createTurnController } from './conversation/turn-controller.mjs';
import { createConversationSession } from './conversation/session.mjs';
import { createDelegationManager } from './conversation/delegation.mjs';
import { createRealtimeTranscriber } from './providers/mistral-realtime-stt.mjs';
import { streamChat } from './providers/mistral-chat.mjs';
import { createWebSearchProvider, WEB_SEARCH_TOOL } from './providers/web-search.mjs';
import { playStreamingSpeech } from './mistral-tts.mjs';
import { createControlServer } from './control-ipc.mjs';

const defaultWrite = process.stdout.write.bind(process.stdout);

export function startDaemon({
  env = process.env,
  argv = process.argv.slice(2),
  write = defaultWrite,
  dependencies = {},
} = {}) {
  const config = loadConfig(env, argv);
  const sessionId = `s_${Date.now().toString(36)}_${process.pid.toString(36)}`;
  const publish = (event) => emitEvent({ sessionId, ...event }, write);
  let stopping;
  let signalHandlersInstalled = false;

  publish({ event: 'daemon_started', mode: config.mode });

  if (argv.includes('--once')) {
    publish({ event: 'listening' });
    return {
      config,
      sessionId,
      ready: Promise.resolve(),
      status: () => ({ sessionId, state: 'LISTENING', mode: config.mode }),
      shutdown: async () => publish({ event: 'daemon_stopped' }),
    };
  }

  const physicalAudioBackend = dependencies.audioBackend ?? createAudioBackend({
    inputDevice: config.inputDevice,
    outputDevice: config.outputDevice,
  });
  const echoSuppressor = config.audioProfile === 'speaker'
    ? dependencies.echoSuppressor ?? createEchoSuppressor()
    : undefined;
  const audioBackend = echoSuppressor
    ? withEchoReference(physicalAudioBackend, echoSuppressor)
    : physicalAudioBackend;
  const vad = dependencies.vad ?? createVad({ sampleRate: config.sampleRate, frameMs: config.frameMs });
  const transcriber = dependencies.transcriber ?? createRealtimeTranscriber({
    apiKey: config.apiKey,
    model: config.sttModel,
    targetDelayMs: config.sttDelayMs,
  });
  const turnController = dependencies.turnController ?? createTurnController();
  const searchProvider = dependencies.searchProvider ?? createWebSearchProvider({
    endpoint: env.VOXTRAL_SEARCH_ENDPOINT,
  });
  const chat = dependencies.streamChat ?? ((options) => streamChat({
    ...options,
    apiKey: config.apiKey,
    model: config.llmModel,
    tools: [WEB_SEARCH_TOOL],
  }));
  const speak = dependencies.speak ?? ((options) => playStreamingSpeech({
    ...options,
    apiKey: config.apiKey,
    model: config.ttsModel,
    voiceId: config.voiceId,
    audioBackend,
  }));
  const delegation = dependencies.delegation ?? createDelegationManager({
    conversationId: sessionId,
    webSearch: (request) => searchProvider.search(request),
    emit: publish,
  });
  const session = createConversationSession({
    conversationId: sessionId,
    audioBackend,
    transcriber,
    turnController,
    vad,
    streamChat: chat,
    speak,
    emit: publish,
    audioProfile: config.audioProfile,
    echoCancellation: config.echoCancellation,
    isPlaybackEcho: dependencies.isPlaybackEcho ?? echoSuppressor?.isPlaybackEcho,
    delegation,
  });

  const controlServerFactory = dependencies.controlServerFactory ?? createControlServer;
  const controlServer = controlServerFactory({
    handlers: {
      status: async () => ({ ...session.status(), sessionId, mode: config.mode, pid: process.pid }),
      say: ({ text }) => session.say(text),
      interrupt: () => session.interrupt('control'),
      shutdown: async () => {
        setImmediate(() => { void shutdown(); });
        return { stopping: true };
      },
    },
  });

  const ready = (async () => {
    try {
      await session.start();
      await controlServer.start();
      installSignalHandlers();
    } catch (error) {
      publish({
        event: 'error',
        code: safeErrorCode(error?.code, 'daemon_start_failed'),
        message: 'Voxtral daemon failed to start',
        recoverable: false,
      });
      await Promise.allSettled([session.shutdown(), controlServer.close()]);
      throw error;
    }
  })();

  return {
    config,
    sessionId,
    session,
    controlServer,
    ready,
    status: session.status,
    shutdown,
  };

  function installSignalHandlers() {
    if (signalHandlersInstalled) return;
    signalHandlersInstalled = true;
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  }

  async function shutdown() {
    if (stopping) return stopping;
    stopping = (async () => {
      if (signalHandlersInstalled) {
        process.removeListener('SIGINT', shutdown);
        process.removeListener('SIGTERM', shutdown);
        signalHandlersInstalled = false;
      }
      await Promise.allSettled([session.shutdown(), controlServer.close()]);
      publish({ event: 'daemon_stopped' });
    })();
    return stopping;
  }
}

function safeErrorCode(code, fallback) {
  return typeof code === 'string' && /^[a-z0-9_-]{1,64}$/i.test(code) ? code : fallback;
}

function withEchoReference(audioBackend, echoSuppressor) {
  return {
    startInput: (handler) => audioBackend.startInput(handler),
    writeOutput(frame) {
      echoSuppressor.pushOutput(frame);
      audioBackend.writeOutput(frame);
    },
    stopOutput() {
      audioBackend.stopOutput();
      echoSuppressor.reset();
    },
    async close() {
      echoSuppressor.reset();
      await audioBackend.close();
    },
  };
}

const isMainModule = process.argv[1]
  && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isMainModule) {
  try {
    const runtime = startDaemon();
    await runtime.ready;
  } catch {
    process.exitCode = 1;
  }
}
