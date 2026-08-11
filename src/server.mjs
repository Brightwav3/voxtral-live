import { readFile } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { extname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { synthesizeSpeech } from './mistral-tts.mjs';
import { transcribeAudio } from './mistral-transcribe.mjs';

const DEFAULT_BASE_URL = 'https://api.mistral.ai';
const DEFAULT_PORT = 4317;
const PUBLIC_ROOT = resolve(fileURLToPath(new URL('../public/', import.meta.url)));

export function createServer({
  apiKey = process.env.MISTRAL_API_KEY,
  baseUrl = process.env.MISTRAL_BASE_URL ?? DEFAULT_BASE_URL,
  fetchImpl = globalThis.fetch,
  publicRoot = PUBLIC_ROOT,
} = {}) {
  return createHttpServer(async (request, response) => {
    try {
      if (request.url === '/api/health' && request.method === 'GET') {
        return sendJson(response, 200, { ok: true });
      }

      if (request.url === '/api/voices' && request.method === 'GET') {
        return await handleVoices({ response, apiKey, baseUrl, fetchImpl });
      }

      if (request.url === '/api/tts' && request.method === 'POST') {
        return await handleTts({ request, response, apiKey, baseUrl, fetchImpl });
      }

      if (request.url === '/api/transcribe' && request.method === 'POST') {
        return await handleTranscription({ request, response, apiKey, baseUrl, fetchImpl });
      }

      if (request.method === 'GET') {
        return await serveStatic({ request, response, publicRoot });
      }

      sendJson(response, 404, { error: 'Not found' });
    } catch (error) {
      const status = error.statusCode ?? 500;
      sendJson(response, status, { error: error instanceof Error ? error.message : 'Unknown error' });
    }
  });
}

async function handleVoices({ response, apiKey, baseUrl, fetchImpl }) {
  requireApiKey(apiKey);
  const upstream = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/v1/audio/voices?type=all&limit=100`, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
  });
  const payload = await readJsonOrText(upstream);
  if (!upstream.ok) throw upstreamError('voice listing', upstream.status, payload);
  sendJson(response, 200, normalizeVoices(payload));
}

async function handleTts({ request, response, apiKey, baseUrl, fetchImpl }) {
  const body = await readJsonBody(request);
  const result = await synthesizeSpeech({
    apiKey,
    baseUrl,
    input: body.text,
    voiceId: body.voiceId,
    refAudio: body.refAudio,
    responseFormat: body.format ?? 'mp3',
    fetchImpl,
  });

  sendBytes(response, 200, result.audio, audioContentType(result.responseFormat), {
    'content-disposition': `inline; filename="voxtral.${result.responseFormat}"`,
  });
}

async function handleTranscription({ request, response, apiKey, baseUrl, fetchImpl }) {
  const form = await readMultipartForm(request);
  const file = form.get('file');
  if (!file || typeof file.arrayBuffer !== 'function') {
    throw clientError('An audio file is required');
  }

  const result = await transcribeAudio({
    apiKey,
    baseUrl,
    fileBytes: Buffer.from(await file.arrayBuffer()),
    fileName: file.name || 'audio.bin',
    language: form.get('language') || undefined,
    fetchImpl,
  });

  sendJson(response, 200, { text: result.text });
}

async function serveStatic({ request, response, publicRoot }) {
  const requestPath = new URL(request.url, 'http://localhost').pathname;
  const relativePath = requestPath === '/' ? 'index.html' : requestPath.slice(1);
  const filePath = resolve(join(publicRoot, relativePath));
  const relativeToRoot = relative(resolve(publicRoot), filePath);
  if (relativeToRoot.startsWith('..') || isAbsolute(relativeToRoot)) {
    return sendJson(response, 404, { error: 'Not found' });
  }

  try {
    const content = await readFile(filePath);
    sendBytes(response, 200, content, staticContentType(extname(filePath)));
  } catch {
    sendJson(response, 404, { error: 'Not found' });
  }
}

async function readJsonBody(request) {
  const body = await readRequestBody(request);
  try {
    return JSON.parse(body.toString('utf8'));
  } catch {
    throw clientError('Request body must be valid JSON');
  }
}

async function readMultipartForm(request) {
  const body = await readRequestBody(request);
  const webRequest = new Request('http://localhost/api/transcribe', {
    method: request.method,
    headers: request.headers,
    body,
  });
  try {
    return await webRequest.formData();
  } catch {
    throw clientError('Request must be multipart form data');
  }
}

function readRequestBody(request) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => resolveBody(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

async function readJsonOrText(response) {
  const contentType = response.headers.get('content-type') ?? '';
  return contentType.includes('application/json') ? response.json() : response.text();
}

function sendJson(response, status, payload) {
  sendBytes(response, status, Buffer.from(JSON.stringify(payload)), 'application/json; charset=utf-8');
}

function sendBytes(response, status, bytes, contentType, extraHeaders = {}) {
  response.writeHead(status, {
    'content-type': contentType,
    'content-length': bytes.length,
    ...extraHeaders,
  });
  response.end(bytes);
}

function requireApiKey(apiKey) {
  if (!apiKey) throw new Error('MISTRAL_API_KEY is required');
}

function clientError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function upstreamError(action, status, payload) {
  const message = typeof payload === 'object' && payload?.message
    ? payload.message
    : typeof payload === 'string'
      ? payload
      : 'Unknown error';
  const error = new Error(`Mistral ${action} failed (${status}): ${message}`);
  error.statusCode = 502;
  return error;
}

function normalizeVoices(payload) {
  if (Array.isArray(payload)) return { data: payload };
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.items)) return payload;

  const { items, ...metadata } = payload;
  return { ...metadata, data: items };
}

function audioContentType(format) {
  return {
    flac: 'audio/flac',
    mp3: 'audio/mpeg',
    opus: 'audio/ogg',
    pcm: 'audio/pcm',
    wav: 'audio/wav',
  }[format] ?? 'application/octet-stream';
}

function staticContentType(extension) {
  return {
    '.css': 'text/css; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
  }[extension] ?? 'application/octet-stream';
}

export function startServer({ port = Number(process.env.PORT) || DEFAULT_PORT, ...options } = {}) {
  const server = createServer(options);
  server.listen(port, () => {
    console.log(`Voxtral Studio running at http://localhost:${port}`);
  });
  return server;
}

const isMainModule = process.argv[1]
  && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isMainModule) startServer();
