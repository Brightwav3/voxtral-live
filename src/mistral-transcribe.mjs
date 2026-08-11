import { readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';

export const DEFAULT_MODEL = 'voxtral-mini-latest';
export const DEFAULT_BASE_URL = 'https://api.mistral.ai';

const MIME_TYPES = {
  '.flac': 'audio/flac',
  '.m4a': 'audio/mp4',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.mpeg': 'video/mpeg',
  '.mpga': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.webm': 'audio/webm',
};

export async function transcribeAudio({
  apiKey = process.env.MISTRAL_API_KEY,
  baseUrl = process.env.MISTRAL_BASE_URL ?? DEFAULT_BASE_URL,
  model = DEFAULT_MODEL,
  filePath,
  fileBytes,
  fileName,
  language,
  fetchImpl = globalThis.fetch,
  readFileImpl = readFile,
} = {}) {
  if (!apiKey) {
    throw new Error('MISTRAL_API_KEY is required');
  }

  if ((!filePath || typeof filePath !== 'string' || !filePath.trim()) && !fileBytes) {
    throw new Error('filePath is required');
  }

  if (typeof fetchImpl !== 'function') {
    throw new Error('fetch is not available in this Node.js runtime');
  }

  const uploadName = fileName ?? (filePath ? basename(filePath) : 'audio.bin');
  const uploadBytes = fileBytes ?? await readFileImpl(filePath);
  const form = new FormData();
  form.append(
    'file',
    new Blob([uploadBytes], { type: MIME_TYPES[extname(uploadName).toLowerCase()] ?? 'application/octet-stream' }),
    uploadName,
  );
  form.append('model', model);

  if (language) form.append('language', language);

  const response = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/v1/audio/transcriptions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
    body: form,
  });

  const payload = await readJsonOrText(response);

  if (!response.ok) {
    const message = typeof payload === 'object' && payload?.message
      ? payload.message
      : typeof payload === 'string'
        ? payload
        : 'Unknown error';
    throw new Error(`Mistral transcription request failed (${response.status}): ${message}`);
  }

  if (!payload || typeof payload.text !== 'string') {
    throw new Error('Mistral transcription response did not contain text');
  }

  return {
    ...payload,
    model,
  };
}

async function readJsonOrText(response) {
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    return response.json();
  }
  return response.text();
}
