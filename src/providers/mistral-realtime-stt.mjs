import WebSocket from 'ws';

export const DEFAULT_REALTIME_MODEL = 'voxtral-mini-transcribe-realtime-2602';
export const DEFAULT_TARGET_DELAY_MS = 240;

const REALTIME_URL = 'wss://api.mistral.ai/v1/audio/transcriptions/realtime';
const MAX_AUDIO_FRAME_BYTES = 262_144;
const MAX_BUFFERED_AMOUNT = 1_048_576;

export function createRealtimeTranscriber({
  apiKey,
  model = DEFAULT_REALTIME_MODEL,
  targetDelayMs = DEFAULT_TARGET_DELAY_MS,
  WebSocketImpl = WebSocket,
} = {}) {
  validateOptions({ apiKey, model, targetDelayMs, WebSocketImpl });

  const handlers = new Map();
  let socket;
  let connectPromise;
  let permanentlyClosed = false;
  let explicitlyClosing = false;
  let inputEnded = false;
  const pendingTurns = [];

  return { connect, beginTurn, pushAudio, endInput, on, close };

  // The provider only emits a final transcript after the input is closed, so
  // the caller ends the utterance when its detector hears the speaker stop.
  function endInput() {
    if (!isOpen(socket, WebSocketImpl) || inputEnded) return false;
    try {
      send(socket, { type: 'input_audio.end' });
    } catch (error) {
      emit('error', providerError(sendFailureCode(error, 'send_failed')));
      return false;
    }
    inputEnded = true;
    return true;
  }

  function beginTurn({ turnId, generationId } = {}, { replaces } = {}) {
    if (typeof turnId !== 'string' || !turnId.trim()) throw new TypeError('turnId is required');
    if (typeof generationId !== 'string' || !generationId.trim()) throw new TypeError('generationId is required');
    if (replaces !== undefined) {
      validateTurnIdentity(replaces, 'replaces');
      const replacedIndex = pendingTurns.findIndex((turn) => sameTurnIdentity(turn, replaces));
      if (replacedIndex !== -1) pendingTurns.splice(replacedIndex, 1);
    }
    const previous = pendingTurns.at(-1);
    if (sameTurnIdentity(previous, { turnId, generationId })) return;
    pendingTurns.push({ turnId, generationId });
  }

  function on(eventName, handler) {
    if (typeof handler !== 'function') throw new TypeError('event handler must be a function');
    const eventHandlers = handlers.get(eventName) ?? new Set();
    eventHandlers.add(handler);
    handlers.set(eventName, eventHandlers);
    return () => eventHandlers.delete(handler);
  }

  async function connect() {
    if (permanentlyClosed) throw new Error('Realtime transcriber is closed');
    if (isOpen(socket, WebSocketImpl)) return;
    if (connectPromise) return connectPromise;

    explicitlyClosing = false;
    inputEnded = false;
    const nextSocket = new WebSocketImpl(`${REALTIME_URL}?model=${encodeURIComponent(model)}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    socket = nextSocket;
    connectPromise = new Promise((resolve, reject) => {
      let settled = false;
      const settle = (callback, value) => {
        if (settled) return;
        settled = true;
        connectPromise = undefined;
        callback(value);
      };

      addListener(nextSocket, 'open', () => {
        if (nextSocket !== socket) return;
        try {
          send(nextSocket, {
            type: 'session.update',
            session: {
              audio_format: { encoding: 'pcm_s16le', sample_rate: 16000 },
              target_streaming_delay_ms: targetDelayMs,
            },
          });
          settle(resolve);
        } catch (error) {
          emit('error', providerError(sendFailureCode(error, 'connection_failed')));
          settle(reject, new Error('Realtime transcription connection failed'));
        }
      });
      addListener(nextSocket, 'message', (message) => handleMessage(readMessageData(message)));
      addListener(nextSocket, 'error', () => {
        emit('error', providerError('connection_error'));
        settle(reject, new Error('Realtime transcription connection failed'));
      });
      addListener(nextSocket, 'close', (event) => {
        if (nextSocket !== socket) return;
        socket = undefined;
        const code = safeCloseCode(event?.code);
        emit('closed', { event: 'closed', code, recoverable: !explicitlyClosing && !permanentlyClosed });
        if (!settled) settle(reject, new Error('Realtime transcription connection closed'));
      });
    });

    return connectPromise;
  }

  function pushAudio(pcmS16leFrame) {
    if (!isOpen(socket, WebSocketImpl) || inputEnded) return false;
    const frame = toBuffer(pcmS16leFrame);
    if (!frame || frame.length === 0 || frame.length > MAX_AUDIO_FRAME_BYTES) return false;

    try {
      send(socket, { type: 'input_audio.append', audio: frame.toString('base64') });
      return true;
    } catch (error) {
      emit('error', providerError(sendFailureCode(error, 'send_failed')));
      return false;
    }
  }

  async function close() {
    permanentlyClosed = true;
    explicitlyClosing = true;
    const activeSocket = socket;
    if (!activeSocket || isClosed(activeSocket, WebSocketImpl)) return;

    if (isOpen(activeSocket, WebSocketImpl) && !inputEnded) {
      try {
        send(activeSocket, { type: 'input_audio.end' });
      } catch (error) {
        emit('error', providerError(sendFailureCode(error, 'send_failed')));
      }
      inputEnded = true;
    }

    await new Promise((resolve) => {
      addListener(activeSocket, 'close', resolve);
      activeSocket.close(1000);
    });
  }

  function handleMessage(data) {
    let payload;
    try {
      payload = JSON.parse(data);
    } catch {
      emit('error', providerError('invalid_provider_message'));
      return;
    }
    if (!payload || typeof payload !== 'object') return;

    if (payload.type === 'session.created') {
      const requestId = payload.session?.request_id;
      emit('session_ready', isSafeRequestId(requestId)
        ? { event: 'session_ready', requestId }
        : { event: 'session_ready' });
    } else if (isTextDelta(payload)) {
      if (typeof payload.text === 'string' && payload.text) emit('partial', { event: 'partial', text: payload.text });
    } else if (isFinalTranscript(payload)) {
      const turn = pendingTurns.shift();
      if (turn && typeof payload.text === 'string' && payload.text) {
        emit('final', { event: 'final', text: payload.text, ...turn });
      }
      renewSession();
    } else if (payload.type === 'error') {
      emit('error', providerError(payload.error?.code));
    }
  }

  // A closed input ends the provider session for good, so the next utterance
  // needs a fresh socket. Reconnect right after the final transcript lands.
  function renewSession() {
    if (permanentlyClosed || !inputEnded) return;
    const staleSocket = socket;
    socket = undefined;
    inputEnded = false;
    connectPromise = undefined;
    if (staleSocket && !isClosed(staleSocket, WebSocketImpl)) {
      try {
        staleSocket.close(1000);
      } catch {
        // The provider may already be tearing the socket down.
      }
    }
    connect().catch(() => emit('error', providerError('reconnect_failed')));
  }

  function emit(eventName, event) {
    for (const handler of handlers.get(eventName) ?? []) handler(event);
  }
}

function validateOptions({ apiKey, model, targetDelayMs, WebSocketImpl }) {
  if (typeof apiKey !== 'string' || !apiKey.trim()) throw new Error('MISTRAL_API_KEY is required');
  if (typeof model !== 'string' || !model.trim()) throw new Error('Realtime transcription model is required');
  if (!Number.isInteger(targetDelayMs) || targetDelayMs <= 0) throw new Error('targetDelayMs must be a positive integer');
  if (typeof WebSocketImpl !== 'function') throw new Error('WebSocket implementation is required');
}

function validateTurnIdentity(identity, name) {
  if (typeof identity?.turnId !== 'string' || !identity.turnId.trim()
      || typeof identity?.generationId !== 'string' || !identity.generationId.trim()) {
    throw new TypeError(`${name} must include turnId and generationId`);
  }
}

function sameTurnIdentity(left, right) {
  return left?.turnId === right?.turnId && left?.generationId === right?.generationId;
}

function addListener(socket, eventName, handler) {
  if (typeof socket.addEventListener === 'function') socket.addEventListener(eventName, handler);
  else socket.on(eventName, handler);
}

function isOpen(socket, WebSocketImpl) {
  return socket?.readyState === WebSocketImpl.OPEN;
}

function isClosed(socket, WebSocketImpl) {
  return socket?.readyState === WebSocketImpl.CLOSED;
}

function send(socket, payload) {
  if (Number.isFinite(socket.bufferedAmount) && socket.bufferedAmount > MAX_BUFFERED_AMOUNT) {
    const error = new Error('Realtime transcription socket is backpressured');
    error.code = 'ERR_REALTIME_BACKPRESSURE';
    throw error;
  }
  socket.send(JSON.stringify(payload));
}

function sendFailureCode(error, fallback) {
  return error?.code === 'ERR_REALTIME_BACKPRESSURE' ? 'backpressure' : fallback;
}

function readMessageData(message) {
  const data = message?.data ?? message;
  return Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
}

function toBuffer(frame) {
  if (Buffer.isBuffer(frame)) return frame;
  if (frame instanceof Uint8Array) return Buffer.from(frame);
  if (frame instanceof ArrayBuffer) return Buffer.from(frame);
  return undefined;
}

function isTextDelta(payload) {
  return ['transcription.text.delta', 'text.delta', 'segment.delta'].includes(payload.type);
}

function isFinalTranscript(payload) {
  return ['transcription.done', 'transcription.completed'].includes(payload.type);
}

function providerError(code) {
  return {
    event: 'error',
    code: safeErrorCode(code),
    message: 'Realtime transcription provider error',
    recoverable: true,
  };
}

function safeErrorCode(code) {
  return typeof code === 'string' && /^[a-z0-9_-]{1,64}$/i.test(code) ? code : 'provider_error';
}

function safeCloseCode(code) {
  return Number.isInteger(code) ? code : 1006;
}

function isSafeRequestId(requestId) {
  return typeof requestId === 'string'
    && /^[a-z0-9_-]{1,128}$/i.test(requestId)
    && !/^(?:sk|rt|token|secret)[_-]/i.test(requestId);
}
