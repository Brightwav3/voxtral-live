import test from 'node:test';
import assert from 'node:assert/strict';

import { createVad } from '../src/audio/vad.mjs';

const quietFrame = () => new Float32Array(320);
const speechFrame = (amplitude = 0.1) => new Float32Array(320).fill(amplitude);
const noiseFrame = (amplitude, index = 0) => {
  const frame = new Float32Array(320);
  for (let position = 0; position < frame.length; position += 1) {
    frame[position] = (position + index) % 2 === 0 ? amplitude : -amplitude;
  }
  return frame;
};

// No speech may start during the calibration window, so tests that exercise
// speech detection warm the detector up on the room's noise floor first.
function calibrate(vad, frame = quietFrame(), frames = 20) {
  for (let index = 0; index < frames; index += 1) {
    const result = vad.push(typeof frame === 'function' ? frame(index) : frame);
    assert.equal(result.speechStarted, false);
  }
  return vad;
}

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
  const vad = calibrate(createVad({ startRms: 0.05, stopRms: 0.03, adaptive: false }));

  assert.equal(vad.push(speechFrame()).speechStarted, false);
  assert.equal(vad.push(speechFrame()).speechStarted, false);
  assert.deepEqual(vad.push(speechFrame()), {
    state: 'speech',
    speechStarted: true,
    speechStopped: false,
  });
});

test('uses signed int16 samples when the microphone provides a Buffer', () => {
  const vad = calibrate(createVad({ startRms: 0.05, stopRms: 0.03, adaptive: false }));
  const speechPcm = Buffer.alloc(640);
  for (let offset = 0; offset < speechPcm.length; offset += 2) speechPcm.writeInt16LE(3277, offset);

  assert.equal(vad.push(speechPcm).speechStarted, false);
  assert.equal(vad.push(speechPcm).speechStarted, false);
  assert.equal(vad.push(speechPcm).speechStarted, true);
});

test('stops speech after 450 ms of silence', () => {
  const vad = calibrate(createVad({ startRms: 0.05, stopRms: 0.03, adaptive: false }));
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

test('detects quiet speech that stays below the fixed default threshold', () => {
  const vad = calibrate(createVad(), (index) => noiseFrame(0.0005, index));
  const quietSpeech = (index) => noiseFrame(0.008, index);

  assert.ok(vad.thresholds().start < 0.02, 'adaptive threshold should drop below the fixed default');
  assert.equal(vad.push(quietSpeech(0)).speechStarted, false);
  assert.equal(vad.push(quietSpeech(1)).speechStarted, false);
  assert.equal(vad.push(quietSpeech(2)).speechStarted, true);
});

test('raises the threshold with the measured noise floor', () => {
  const vad = calibrate(createVad(), (index) => noiseFrame(0.01, index));

  assert.ok(vad.noiseFloorRms() > 0.008, 'noise floor should track the room noise');
  assert.ok(vad.thresholds().start > 0.02, 'threshold should rise above the fixed default in a noisy room');

  for (let index = 0; index < 10; index += 1) {
    assert.equal(vad.push(noiseFrame(0.02, index)).speechStarted, false, 'noise must not be treated as speech');
  }
  for (let index = 0; index < 3; index += 1) vad.push(noiseFrame(0.2, index));
  assert.equal(vad.push(noiseFrame(0.2, 3)).state, 'speech');
});

test('never floors the threshold below minStartRms', () => {
  const vad = calibrate(createVad({ minStartRms: 0.004 }), quietFrame());

  assert.equal(vad.noiseFloorRms(), 0);
  assert.equal(vad.thresholds().start, 0.004);
  for (let index = 0; index < 30; index += 1) {
    assert.equal(vad.push(noiseFrame(0.001, index)).speechStarted, false);
  }
});

test('suppresses false triggers during the startup calibration window', () => {
  const vad = createVad({ calibrationMs: 300, frameMs: 20 });

  for (let index = 0; index < 15; index += 1) {
    assert.equal(vad.push(speechFrame(0.5)).speechStarted, false, `frame ${index} started speech during calibration`);
  }
  assert.equal(vad.push(speechFrame(0.5)).speechStarted, false);
  assert.equal(vad.push(speechFrame(0.5)).speechStarted, false);
  assert.equal(vad.push(speechFrame(0.5)).speechStarted, true);
});

test('keeps calibration and the noise floor across a mid-stream reset', () => {
  const vad = calibrate(createVad(), (index) => noiseFrame(0.0005, index));
  const floor = vad.noiseFloorRms();
  for (let index = 0; index < 3; index += 1) vad.push(speechFrame());
  vad.reset();

  assert.equal(vad.noiseFloorRms(), floor);
  assert.equal(vad.push(speechFrame()).state, 'silence');
  assert.equal(vad.push(speechFrame()).speechStarted, false);
  assert.equal(vad.push(speechFrame()).speechStarted, true);
});

test('accepts named sensitivity presets and rejects unknown ones', () => {
  const high = calibrate(createVad({ sensitivity: 'high' }), (index) => noiseFrame(0.0005, index));
  const low = calibrate(createVad({ sensitivity: 'low' }), (index) => noiseFrame(0.0005, index));

  assert.ok(high.thresholds().start < low.thresholds().start);
  assert.throws(() => createVad({ sensitivity: 'ultra' }), /sensitivity must be one of/);
});

test('rejects an inverted adaptive threshold range', () => {
  assert.throws(() => createVad({ minStartRms: 0.09, maxStartRms: 0.01 }), /minStartRms/);
});
