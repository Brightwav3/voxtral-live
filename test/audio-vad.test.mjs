import test from 'node:test';
import assert from 'node:assert/strict';

import { createVad } from '../src/audio/vad.mjs';

const quietFrame = () => new Float32Array(320);
const speechFrame = (amplitude = 0.1) => new Float32Array(320).fill(amplitude);

test('keeps silence inactive', () => {
  const vad = createVad({ startRms: 0.05, stopRms: 0.03 });

  for (let index = 0; index < 30; index += 1) {
    assert.deepEqual(vad.push(quietFrame()), {
      state: 'silence',
      speechStarted: false,
      speechStopped: false,
    });
  }
});

test('starts speech after a 60 ms attack', () => {
  const vad = createVad({ startRms: 0.05, stopRms: 0.03 });

  assert.equal(vad.push(speechFrame()).speechStarted, false);
  assert.equal(vad.push(speechFrame()).speechStarted, false);
  assert.deepEqual(vad.push(speechFrame()), {
    state: 'speech',
    speechStarted: true,
    speechStopped: false,
  });
});

test('uses signed int16 samples when the microphone provides a Buffer', () => {
  const vad = createVad({ startRms: 0.05, stopRms: 0.03 });
  const speechPcm = Buffer.alloc(640);
  for (let offset = 0; offset < speechPcm.length; offset += 2) speechPcm.writeInt16LE(3277, offset);

  assert.equal(vad.push(speechPcm).speechStarted, false);
  assert.equal(vad.push(speechPcm).speechStarted, false);
  assert.equal(vad.push(speechPcm).speechStarted, true);
});

test('stops speech after 450 ms of silence', () => {
  const vad = createVad({ startRms: 0.05, stopRms: 0.03 });
  for (let index = 0; index < 3; index += 1) vad.push(speechFrame());

  for (let index = 0; index < 22; index += 1) {
    assert.equal(vad.push(quietFrame()).speechStopped, false);
  }
  assert.deepEqual(vad.push(quietFrame()), {
    state: 'silence',
    speechStarted: false,
    speechStopped: true,
  });
});

test('recognizes a user interruption after playback has started', () => {
  const vad = createVad({ startRms: 0.05, stopRms: 0.03 });
  const playbackIsActive = true;

  assert.equal(playbackIsActive, true);
  assert.equal(vad.push(speechFrame()).speechStarted, false);
  assert.equal(vad.push(speechFrame()).speechStarted, false);
  assert.equal(vad.push(speechFrame()).speechStarted, true);
});
