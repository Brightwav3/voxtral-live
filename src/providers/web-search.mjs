const ALLOWED_INPUT_KEYS = new Set(['query', 'recencyDays']);
const MAX_RESULTS = 10;

export const WEB_SEARCH_TOOL = Object.freeze({
  type: 'function',
  function: {
    name: 'web_search',
    description: 'Search the web for current factual information.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['query'],
      properties: {
        query: { type: 'string', minLength: 1, maxLength: 500 },
        recencyDays: { type: 'integer', minimum: 1, maximum: 3650 },
      },
    },
  },
});

export function validateWebSearchInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw searchError('invalid_search_input');
  const unsupported = Object.keys(input).filter((key) => !ALLOWED_INPUT_KEYS.has(key));
  if (unsupported.length > 0) throw searchError('unsupported_search_input', `Unsupported web_search field: ${unsupported[0]}`);
  const query = typeof input.query === 'string' ? input.query.trim().replace(/\s+/g, ' ') : '';
  if (!query || query.length > 500) throw searchError('invalid_search_query', 'web_search query must contain 1 to 500 characters');
  if (input.recencyDays !== undefined
      && (!Number.isInteger(input.recencyDays) || input.recencyDays < 1 || input.recencyDays > 3650)) {
    throw searchError('invalid_search_recency', 'web_search recencyDays must be an integer from 1 to 3650');
  }
  return { query, ...(input.recencyDays === undefined ? {} : { recencyDays: input.recencyDays }) };
}

export function createWebSearchProvider({
  endpoint = process.env.VOXTRAL_SEARCH_ENDPOINT,
  fetchImpl = globalThis.fetch,
  searchImpl,
} = {}) {
  if (searchImpl !== undefined && typeof searchImpl !== 'function') throw new TypeError('searchImpl must be a function');
  if (!searchImpl && typeof fetchImpl !== 'function') throw new TypeError('fetch implementation is required');

  return { search };

  async function search({ signal, ...input } = {}) {
    const request = validateWebSearchInput(input);
    if (signal?.aborted) throw abortError(signal.reason);
    let payload;
    try {
      if (searchImpl) {
        payload = await searchImpl({ ...request, signal });
      } else {
        if (typeof endpoint !== 'string' || !endpoint.trim()) {
          throw searchError('search_unavailable', 'Web search is not configured');
        }
        const response = await fetchImpl(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify(request),
          signal,
        });
        if (!response?.ok) throw searchError('search_request_failed');
        payload = await response.json();
      }
    } catch (error) {
      if (error?.name === 'AbortError' || signal?.aborted) throw abortError(signal?.reason);
      if (error?.code) throw error;
      throw searchError('search_request_failed');
    }
    if (signal?.aborted) throw abortError(signal.reason);
    const results = Array.isArray(payload) ? payload : payload?.results;
    if (!Array.isArray(results)) throw searchError('invalid_search_response');
    return results.slice(0, MAX_RESULTS).map(normalizeResult);
  }
}

function normalizeResult(result) {
  if (!result || typeof result !== 'object') throw searchError('invalid_search_response');
  const title = plainText(result.title);
  const snippet = plainText(result.snippet);
  let url;
  try {
    const parsed = new URL(result.url);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('unsupported protocol');
    url = parsed.href;
  } catch {
    throw searchError('invalid_search_response');
  }
  if (!title || !snippet) throw searchError('invalid_search_response');
  let publishedAt = null;
  if (result.publishedAt !== undefined && result.publishedAt !== null && result.publishedAt !== '') {
    const timestamp = new Date(result.publishedAt);
    if (Number.isNaN(timestamp.valueOf())) throw searchError('invalid_search_response');
    publishedAt = timestamp.toISOString();
  }
  return { title, url, snippet, publishedAt };
}

function plainText(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function searchError(code, message = 'Web search failed') {
  const error = new Error(message);
  error.code = code;
  error.recoverable = true;
  return error;
}

function abortError(reason) {
  const error = new Error(typeof reason === 'string' ? reason : 'Web search cancelled');
  error.name = 'AbortError';
  return error;
}
