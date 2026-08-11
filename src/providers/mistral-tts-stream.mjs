export const DEFAULT_TTS_MODEL = 'voxtral-mini-tts-2603';
export const DEFAULT_TTS_BASE_URL = 'https://api.mistral.ai';

export async function* streamSpeech({
  apiKey = process.env.MISTRAL_API_KEY,
  baseUrl = process.env.MISTRAL_BASE_URL ?? DEFAULT_TTS_BASE_URL,
  model = DEFAULT_TTS_MODEL,
  input,
  voiceId,
  refAudio,
  signal,
  fetchImpl = globalThis.fetch,
} = {}) {
  validateRequest({ apiKey, baseUrl, model, input, voiceId, refAudio, fetchImpl });
  if (signal?.aborted) return;

  let response;
  try {
    response = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/v1/audio/speech`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify({
        model,
        input,
        response_format: 'pcm',
        stream: true,
        ...(voiceId ? { voice_id: voiceId } : {}),
        ...(refAudio ? { ref_audio: refAudio } : {}),
      }),
      signal,
    });
  } catch (error) {
    if (error?.name === 'AbortError' || signal?.aborted) return;
    throw ttsError('tts_request_failed', 'Mistral TTS request failed');
  }

  if (signal?.aborted) return;
  if (!response?.ok || !response.body) throw ttsError('tts_request_failed', 'Mistral TTS request failed');

  for await (const event of readServerSentEvents(response.body, signal)) {
    if (signal?.aborted || event === '[DONE]' || event?.type === 'speech.audio.done') return;
    const audioData = event?.audio_data;
    if (typeof audioData !== 'string' || !isBase64(audioData)) {
      throw ttsError('invalid_stream', 'Mistral TTS stream failed');
    }
    if (signal?.aborted) return;
    yield Buffer.from(audioData, 'base64');
  }
}

function validateRequest({ apiKey, baseUrl, model, input, voiceId, refAudio, fetchImpl }) {
  if (typeof apiKey !== 'string' || !apiKey.trim()) throw ttsError('missing_api_key', 'Mistral TTS request failed');
  if (typeof baseUrl !== 'string' || !baseUrl.trim()) throw ttsError('invalid_base_url', 'Mistral TTS request failed');
  if (typeof model !== 'string' || !model.trim()) throw ttsError('invalid_model', 'Mistral TTS request failed');
  if (typeof input !== 'string' || !input.trim()) throw ttsError('invalid_input', 'Mistral TTS request failed');
  if (voiceId && refAudio) throw ttsError('invalid_voice', 'Mistral TTS request failed');
  if (typeof fetchImpl !== 'function') throw ttsError('fetch_unavailable', 'Mistral TTS request failed');
}

async function* readServerSentEvents(body, signal) {
  let reader;
  let buffer = '';
  try {
    reader = body.getReader();
    const decoder = new TextDecoder();
    while (!signal?.aborted) {
      const { done, value } = await reader.read();
      if (signal?.aborted) return;
      buffer += decoder.decode(value, { stream: !done });
      const events = buffer.split(/\r?\n\r?\n/);
      buffer = events.pop();
      for (const event of events) {
        const payload = parseServerSentEvent(event);
        if (payload !== undefined) yield payload;
      }
      if (done) {
        const payload = parseServerSentEvent(buffer);
        if (payload !== undefined) yield payload;
        return;
      }
    }
  } catch (error) {
    if (error?.recoverable) throw error;
    if (error?.name === 'AbortError' || signal?.aborted) return;
    throw ttsError('tts_stream_failed', 'Mistral TTS stream failed');
  } finally {
    if (signal?.aborted) await reader?.cancel().catch(() => {});
    reader?.releaseLock();
  }
}

function parseServerSentEvent(event) {
  const data = event.split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim())
    .join('\n');
  if (!data) return undefined;
  if (data === '[DONE]') return data;
  try {
    return JSON.parse(data);
  } catch {
    throw ttsError('invalid_stream', 'Mistral TTS stream failed');
  }
}

function isBase64(value) {
  return value.length > 0 && value.length % 4 === 0 && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value);
}

function ttsError(code, message) {
  const error = new Error(message);
  error.code = code;
  error.recoverable = true;
  return error;
}
