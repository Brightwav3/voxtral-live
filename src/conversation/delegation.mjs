import { validateWebSearchInput } from '../providers/web-search.mjs';

const DEFAULT_ACKNOWLEDGEMENT = "I'll look that up.";

export function createDelegationManager({
  conversationId,
  webSearch,
  emit = () => {},
  acknowledgement = DEFAULT_ACKNOWLEDGEMENT,
} = {}) {
  if (typeof conversationId !== 'string' || !conversationId.trim()) throw new TypeError('conversationId is required');
  if (typeof webSearch !== 'function') throw new TypeError('webSearch must be a function');
  if (typeof emit !== 'function') throw new TypeError('emit must be a function');
  if (typeof acknowledgement !== 'string' || !acknowledgement.trim()) throw new TypeError('acknowledgement is required');

  const jobs = new Set();
  let currentTurnId;

  return { beginTurn, delegateWebSearch, invalidateTurn, shutdown };

  function beginTurn(turnId) {
    validateTurnId(turnId);
    if (turnId === currentTurnId) return;
    currentTurnId = turnId;
    for (const job of jobs) {
      if (job.turnId !== turnId) job.controller.abort('newer_turn');
    }
  }

  function delegateWebSearch({ turnId, signal, ...input } = {}) {
    validateTurnId(turnId);
    const request = validateWebSearchInput(input);
    if (currentTurnId === undefined) beginTurn(turnId);
    const controller = new AbortController();
    const job = { conversationId, turnId, controller };
    jobs.add(job);
    const unlink = linkAbortSignal(signal, controller);
    emit({
      event: 'assistant_acknowledgement',
      conversationId,
      turnId,
      text: acknowledgement.trim(),
    });
    const result = runJob(job, request).finally(() => {
      unlink();
      jobs.delete(job);
    });
    return { acknowledgement: acknowledgement.trim(), result };
  }

  async function runJob(job, request) {
    try {
      const results = await webSearch({ ...request, signal: job.controller.signal });
      if (job.controller.signal.aborted || currentTurnId !== job.turnId) return discarded(job);
      return {
        status: 'completed',
        conversationId,
        turnId: job.turnId,
        results,
        citations: results.map(({ title, url, publishedAt }) => ({ title, url, publishedAt })),
      };
    } catch (error) {
      if (job.controller.signal.aborted || error?.name === 'AbortError' || currentTurnId !== job.turnId) {
        return discarded(job);
      }
      throw error;
    }
  }

  function invalidateTurn(turnId, reason = 'invalidated') {
    validateTurnId(turnId);
    for (const job of jobs) {
      if (job.turnId === turnId) job.controller.abort(reason);
    }
    if (currentTurnId === turnId) currentTurnId = undefined;
  }

  function shutdown() {
    for (const job of jobs) job.controller.abort('shutdown');
    currentTurnId = undefined;
  }

  function discarded(job) {
    return {
      status: 'discarded',
      conversationId,
      turnId: job.turnId,
      results: [],
      citations: [],
    };
  }
}

export function toSpeechText(text) {
  if (typeof text !== 'string') return '';
  return text
    .replace(/\[([^\]]+)\]\(https?:\/\/[^)]+\)/gi, '$1')
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function validateTurnId(turnId) {
  if (typeof turnId !== 'string' || !turnId.trim()) throw new TypeError('turnId is required');
}

function linkAbortSignal(signal, controller) {
  if (!signal) return () => {};
  const abort = () => controller.abort(signal.reason ?? 'cancelled');
  if (signal.aborted) abort();
  else signal.addEventListener('abort', abort, { once: true });
  return () => signal.removeEventListener('abort', abort);
}
