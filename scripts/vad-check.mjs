// Live microphone check: opens the real input device at 16 kHz mono int16 and
// prints the measured RMS, the adaptive threshold and every VAD transition.
// Usage: node scripts/vad-check.mjs --input-device 13 [--seconds 15] [--vad-sensitivity high]
import { createAudioBackend } from '../src/audio/audio-backend.mjs';
import { createVad } from '../src/audio/vad.mjs';

const argv = process.argv.slice(2);
const inputDevice = readNumber('--input-device');
const seconds = readNumber('--seconds') ?? 15;
const sensitivity = readString('--vad-sensitivity');
const vad = createVad({ ...(sensitivity ? { sensitivity } : {}) });
const backend = createAudioBackend({ inputDevice });

let frames = 0;
let peak = 0;

try {
  await backend.startInput((frame) => {
    frames += 1;
    const rms = rmsOfInt16(frame);
    peak = Math.max(peak, rms);
    const activity = vad.push(frame);
    if (activity.speechStarted) log('speech_started', rms);
    if (activity.speechStopped) log('speech_stopped', rms);
    if (frames % 25 === 0) log('level', rms);
  });
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

console.log(`listening on device ${inputDevice ?? 'default'} for ${seconds}s at 16000 Hz mono int16`);
await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
await backend.close();
console.log(JSON.stringify({
  frames,
  peakRms: round(peak),
  noiseFloorRms: round(vad.noiseFloorRms() ?? 0),
  thresholds: { start: round(vad.thresholds().start), stop: round(vad.thresholds().stop) },
}));

function log(event, rms) {
  const { start } = vad.thresholds();
  console.log(`${event.padEnd(14)} rms=${round(rms)} threshold=${round(start)} floor=${round(vad.noiseFloorRms() ?? 0)}`);
}

function rmsOfInt16(frame) {
  let total = 0;
  for (let offset = 0; offset + 1 < frame.length; offset += 2) {
    const sample = frame.readInt16LE(offset) / 32768;
    total += sample * sample;
  }
  return Math.sqrt(total / (frame.length / 2));
}

function round(value) {
  return Number(value.toFixed(5));
}

function readString(flag) {
  const index = argv.indexOf(flag);
  return index === -1 ? undefined : argv[index + 1];
}

function readNumber(flag) {
  const value = readString(flag);
  return value === undefined ? undefined : Number(value);
}
