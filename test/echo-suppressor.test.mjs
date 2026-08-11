import test from 'node:test';
import assert from 'node:assert/strict';

import { createEchoSuppressor } from '../src/audio/echo-suppressor.mjs';

test('recognizes correlated speaker output in a 16 kHz microphone frame', () => {
  const suppressor = createEchoSuppressor({ correlationThreshold: 0.8 });
  suppressor.pushOutput(signalFrame(24_000, 480, 440));

  assert.equal(suppressor.isPlaybackEcho(toPcm16(signalFrame(16_000, 320, 440))), true);
});

test('keeps unrelated user speech and reset output unsuppressed', () => {
  const suppressor = createEchoSuppressor({ correlationThreshold: 0.8 });
  suppressor.pushOutput(signalFrame(24_000, 480, 440));
  const userSpeech = toPcm16(signalFrame(16_000, 320, 910));

  assert.equal(suppressor.isPlaybackEcho(userSpeech), false);
  suppressor.pushOutput(signalFrame(24_000, 480, 910));
  suppressor.reset();
  assert.equal(suppressor.isPlaybackEcho(userSpeech), false);
});

function signalFrame(sampleRate, length, frequency) {
  return Float32Array.from({ length }, (_, index) => Math.sin(2 * Math.PI * frequency * index / sampleRate) * 0.25);
}

function toPcm16(frame) {
  const buffer = Buffer.alloc(frame.length * 2);
  frame.forEach((sample, index) => buffer.writeInt16LE(Math.round(sample * 32767), index * 2));
  return buffer;
}
