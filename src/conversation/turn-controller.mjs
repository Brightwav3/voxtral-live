export function createTurnController({ silenceMs = 550, minWords = 1 } = {}) {
  if (!Number.isFinite(silenceMs) || silenceMs < 0) throw new Error('silenceMs must be a non-negative number');
  if (!Number.isInteger(minWords) || minWords < 1) throw new Error('minWords must be a positive integer');

  const handlers = new Map();
  let pendingFinal = '';
  let lastEmitted = '';
  let timer;
  let dedupeTimer;

  return { pushPartial, pushFinal, on, reset };

  function pushPartial() {
    // Partial transcripts are inherently unstable and must never start a turn.
  }

  function pushFinal(text) {
    pendingFinal = normalize(text);
    clearTimeout(timer);
    if (pendingFinal === lastEmitted) {
      pendingFinal = '';
      return;
    }
    if (!pendingFinal || countWords(pendingFinal) < minWords) return;
    timer = setTimeout(emitPendingTurn, silenceMs);
  }

  function on(eventName, handler) {
    if (typeof handler !== 'function') throw new TypeError('event handler must be a function');
    const eventHandlers = handlers.get(eventName) ?? new Set();
    eventHandlers.add(handler);
    handlers.set(eventName, eventHandlers);
    return () => eventHandlers.delete(handler);
  }

  function reset() {
    clearTimeout(timer);
    clearTimeout(dedupeTimer);
    timer = undefined;
    dedupeTimer = undefined;
    pendingFinal = '';
    lastEmitted = '';
  }

  function emitPendingTurn() {
    timer = undefined;
    const text = pendingFinal;
    pendingFinal = '';
    if (!text) return;
    lastEmitted = text;
    clearTimeout(dedupeTimer);
    dedupeTimer = setTimeout(() => {
      lastEmitted = '';
      dedupeTimer = undefined;
    }, silenceMs);
    for (const handler of handlers.get('turn') ?? []) handler({ text });
  }
}

function normalize(text) {
  return typeof text === 'string' ? text.trim().replace(/\s+/g, ' ') : '';
}

function countWords(text) {
  return text.split(/\s+/).filter(Boolean).length;
}
