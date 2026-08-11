import { createSentenceChunker } from '../conversation/sentence-chunker.mjs';

export const DEFAULT_CHAT_MODEL = 'mistral-small-latest';
export const DEFAULT_CHAT_BASE_URL = 'https://api.mistral.ai';
export const CHAT_SYSTEM_PROMPT = 'Reply with short, natural sentences. Do not use Markdown.';
export const DEFAULT_HISTORY_TOKEN_BUDGET = 2400;

export async function* streamChat({
  apiKey = process.env.MISTRAL_API_KEY,
  model = process.env.MISTRAL_LLM_MODEL ?? DEFAULT_CHAT_MODEL,
  messages,
  tools,
  signal,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (typeof apiKey !== 'string' || !apiKey.trim()) throw chatError('missing_api_key', 'Mistral chat request failed');
  if (typeof model !== 'string' || !model.trim()) throw chatError('invalid_model', 'Mistral chat request failed');
  if (!Array.isArray(messages)) throw chatError('invalid_messages', 'Mistral chat request failed');
  if (typeof fetchImpl !== 'function') throw chatError('fetch_unavailable', 'Mistral chat request failed');

  let response;
  try {
    response = await fetchImpl(`${DEFAULT_CHAT_BASE_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        stream: true,
        messages: buildMessages(messages),
        ...(Array.isArray(tools) && tools.length > 0 ? { tools } : {}),
      }),
      signal,
    });
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    throw chatError('chat_request_failed', 'Mistral chat request failed');
  }

  if (!response?.ok || !response.body) throw chatError('chat_request_failed', 'Mistral chat request failed');

  const chunker = createSentenceChunker();
  for await (const payload of readServerSentEvents(response.body)) {
    if (payload === '[DONE]') break;
    const text = assistantDelta(payload);
    if (!text) continue;
    yield { event: 'delta', text };
    for (const sentence of chunker.push(text)) yield { event: 'sentence_ready', text: sentence };
  }
  for (const sentence of chunker.flush()) yield { event: 'sentence_ready', text: sentence };
}

function buildMessages(messages) {
  const valid = messages.filter((message) => message && typeof message.role === 'string' && typeof message.content === 'string');
  const history = valid.filter((message) => message.role !== 'system');
  const oldHistory = history.slice(0, -24);
  const recentHistory = history.slice(-24);
  const summary = estimateTokens(history) > DEFAULT_HISTORY_TOKEN_BUDGET ? summarize(oldHistory) : '';
  return [
    { role: 'system', content: CHAT_SYSTEM_PROMPT },
    ...(summary ? [{ role: 'system', content: `Conversation summary: ${summary}` }] : []),
    ...recentHistory,
  ];
}

function summarize(messages) {
  const text = messages.map((message) => `${message.role}: ${message.content}`).join(' ').trim();
  return text ? text.slice(0, 1200) : '';
}

function estimateTokens(messages) {
  return Math.ceil(messages.reduce((total, message) => total + message.content.length, 0) / 4);
}

async function* readServerSentEvents(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const events = buffer.split(/\r?\n\r?\n/);
      buffer = events.pop();
      for (const event of events) {
        const data = event.split(/\r?\n/).filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trim()).join('\n');
        if (!data) continue;
        if (data === '[DONE]') {
          yield data;
          return;
        }
        try {
          yield JSON.parse(data);
        } catch {
          throw chatError('invalid_stream', 'Mistral chat stream failed');
        }
      }
      if (done) break;
    }
  } finally {
    reader.releaseLock();
  }
}

function assistantDelta(payload) {
  const content = payload?.choices?.[0]?.delta?.content;
  return typeof content === 'string' ? content : '';
}

function chatError(code, message) {
  const error = new Error(message);
  error.code = code;
  error.recoverable = true;
  return error;
}
