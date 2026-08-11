import { readFile } from 'node:fs/promises';
import { streamSpeech } from './providers/mistral-tts-stream.mjs';

export { streamSpeech };

export const DEFAULT_MODEL = 'voxtral-mini-tts-2603';
export const DEFAULT_BASE_URL = 'https://api.mistral.ai';

const RESPONSE_FORMATS = new Set(['pcm', 'wav', 'mp3', 'flac', 'opus']);

export async function encodeAudioFile(filePath, readFileImpl = readFile) {
  if (typeof filePath !== 'string' || !filePath.trim()) {
    throw new Error('reference audio path is required');
  }

  const bytes = await readFileImpl(filePath);
  return Buffer.from(bytes).toString('base64');
}

export async function synthesizeSpeech({
  apiKey = process.env.MISTRAL_API_KEY,
  baseUrl = process.env.MISTRAL_BASE_URL ?? DEFAULT_BASE_URL,
  model = DEFAULT_MODEL,
  input,
  voiceId,
  refAudio,
  responseFormat = 'mp3',
  stream = false,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!apiKey) {
    throw new Error('MISTRAL_API_KEY is required');
  }

  if (typeof input !== 'string' || !input.trim()) {
    throw new Error('input must not be empty');
  }

  if (!RESPONSE_FORMATS.has(responseFormat)) {
    throw new Error(`Unsupported response format: ${responseFormat}`);
  }

  if (voiceId && refAudio) {
    throw new Error('voiceId and refAudio cannot be used together');
  }

  if (stream) {
    throw new Error('Streaming TTS is not implemented in this starter integration');
  }

  if (typeof fetchImpl !== 'function') {
    throw new Error('fetch is not available in this Node.js runtime');
  }

  const body = {
    model,
    input,
    response_format: responseFormat,
    stream: false,
  };

  if (voiceId) body.voice_id = voiceId;
  if (refAudio) body.ref_audio = refAudio;

  const response = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/v1/audio/speech`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(body),
  });

  const payload = await readJsonOrText(response);

  if (!response.ok) {
    const message = typeof payload === 'object' && payload?.message
      ? payload.message
      : typeof payload === 'string'
        ? payload
        : 'Unknown error';
    throw new Error(`Mistral TTS request failed (${response.status}): ${message}`);
  }

  if (!payload || typeof payload.audio_data !== 'string') {
    throw new Error('Mistral TTS response did not contain audio_data');
  }

  return {
    audio: Buffer.from(payload.audio_data, 'base64'),
    audioData: payload.audio_data,
    model,
    responseFormat,
  };
}

export async function playStreamingSpeech({ audioBackend, signal, ...streamOptions } = {}) {
  if (!audioBackend || typeof audioBackend.writeOutput !== 'function') {
    throw new Error('audioBackend.writeOutput is required');
  }

  let trailingByte;
  for await (const pcmChunk of streamSpeech({ ...streamOptions, signal })) {
    if (signal?.aborted) return;
    const bytes = trailingByte === undefined
      ? pcmChunk
      : Buffer.concat([Buffer.from([trailingByte]), pcmChunk]);
    trailingByte = bytes.length % 2 === 0 ? undefined : bytes.at(-1);
    const sampleBytes = trailingByte === undefined ? bytes : bytes.subarray(0, -1);
    if (sampleBytes.length === 0 || signal?.aborted) continue;
    audioBackend.writeOutput(pcm16ToFloat32(sampleBytes));
    if (signal?.aborted) return;
  }
}

function pcm16ToFloat32(bytes) {
  const output = new Float32Array(bytes.length / 2);
  for (let offset = 0; offset < bytes.length; offset += 2) {
    output[offset / 2] = bytes.readInt16LE(offset) / 32768;
  }
  return output;
}

async function readJsonOrText(response) {
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    return response.json();
  }
  return response.text();
}
