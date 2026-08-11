// Diagnostic: streams real microphone audio to the realtime STT endpoint and
// prints every message type the provider sends back. Never prints the API key.
// Usage: node --env-file=.env scripts/stt-probe.mjs --input-device 13 --seconds 8
import WebSocket from 'ws';

import { createAudioBackend } from '../src/audio/audio-backend.mjs';

const argv = process.argv.slice(2);
const inputDevice = numberArg('--input-device');
const seconds = numberArg('--seconds') ?? 8;
const model = process.env.MISTRAL_STT_MODEL ?? 'voxtral-mini-transcribe-realtime-2602';
const apiKey = process.env.MISTRAL_API_KEY;
if (!apiKey) {
  console.error('MISTRAL_API_KEY is missing; run with node --env-file=.env');
  process.exit(1);
}

const socket = new WebSocket(
  `wss://api.mistral.ai/v1/audio/transcriptions/realtime?model=${encodeURIComponent(model)}`,
  { headers: { Authorization: `Bearer ${apiKey}` } },
);
const backend = createAudioBackend({ inputDevice });
const seen = new Map();
let sentFrames = 0;

socket.on('open', async () => {
  console.log('websocket open');
  socket.send(JSON.stringify({
    type: 'session.update',
    session: {
      audio_format: { encoding: 'pcm_s16le', sample_rate: 16000 },
      target_streaming_delay_ms: 240,
    },
  }));
  await backend.startInput((frame) => {
    if (socket.readyState !== WebSocket.OPEN) return;
    sentFrames += 1;
    socket.send(JSON.stringify({ type: 'input_audio.append', audio: Buffer.from(frame).toString('base64') }));
  });
  console.log(`streaming ${seconds}s from device ${inputDevice ?? 'default'} — talk now`);
  setTimeout(finish, seconds * 1000);
});

socket.on('message', (data) => {
  const raw = data.toString('utf8');
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    console.log('non-json message', raw.slice(0, 200));
    return;
  }
  const type = payload.type ?? '(no type)';
  seen.set(type, (seen.get(type) ?? 0) + 1);
  console.log(type, JSON.stringify(payload).slice(0, 300));
});

socket.on('error', (error) => console.error('websocket error:', error.message));
socket.on('close', (code, reason) => console.log('websocket closed', code, reason.toString().slice(0, 200)));

async function finish() {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'input_audio.end' }));
  await new Promise((resolve) => setTimeout(resolve, 3000));
  await backend.close();
  if (socket.readyState === WebSocket.OPEN) socket.close(1000);
  console.log('frames sent:', sentFrames);
  console.log('message types:', JSON.stringify(Object.fromEntries(seen)));
  process.exit(0);
}

function numberArg(flag) {
  const index = argv.indexOf(flag);
  return index === -1 ? undefined : Number(argv[index + 1]);
}
