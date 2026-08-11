import test from 'node:test';
import assert from 'node:assert/strict';

import { createAudioBackend } from '../src/audio/audio-backend.mjs';
import { createVad } from '../src/audio/vad.mjs';

test('opens exact mono PCM streams and closes both streams', async () => {
  const { PortAudio, streams } = createFakePortAudio();
  const received = [];
  const backend = createAudioBackend({ inputDevice: 2, outputDevice: 7, PortAudio });

  await backend.startInput((frame) => received.push(frame));
  backend.writeOutput(new Float32Array([1, -1]));
  await waitFor(() => streams.length === 2 && streams[1].writes.length === 1);
  streams[0].emit('data', Buffer.from([1, 2]));
  await backend.close();

  assert.deepEqual(streams[0].options, {
    inOptions: {
      channelCount: 1,
      sampleFormat: 's16',
      sampleRate: 16000,
      framesPerBuffer: 320,
      deviceId: 2,
      closeOnError: true,
    },
  });
  assert.deepEqual(streams[1].options, {
    outOptions: {
      channelCount: 1,
      sampleFormat: 'f32',
      sampleRate: 24000,
      framesPerBuffer: 480,
      deviceId: 7,
      closeOnError: true,
    },
  });
  assert.deepEqual(received, [Buffer.from([1, 2])]);
  assert.equal(streams[0].started, 1);
  assert.equal(streams[1].started, 1);
  assert.equal(streams[0].quitCalls, 1);
  assert.equal(streams[1].quitCalls, 1);
});

test('close during input startup prevents a late stream start', async () => {
  const { PortAudio, streams } = createFakePortAudio();
  const backend = createAudioBackend({ PortAudio });

  const starting = backend.startInput(() => {});
  await backend.close();
  await starting;

  assert.equal(streams.length, 0);
});

test('rejects concurrent input starts before the first load resolves', async () => {
  const { PortAudio } = createFakePortAudio();
  const backend = createAudioBackend({ PortAudio });

  const firstStart = backend.startInput(() => {});
  await assert.rejects(() => backend.startInput(() => {}), /already starting or started/);
  await firstStart;
  await backend.close();
});

test('interrupting speech stops the active output stream and discards stale audio', async () => {
  const { PortAudio, streams } = createFakePortAudio();
  const backend = createAudioBackend({ PortAudio });
  const vad = createVad({ startRms: 0.05, stopRms: 0.03 });

  backend.writeOutput(new Float32Array([1]));
  await waitFor(() => streams.length === 1 && streams[0].writes.length === 1);
  backend.writeOutput(new Float32Array([2]));
  vad.push(new Float32Array(320).fill(0.1));
  vad.push(new Float32Array(320).fill(0.1));
  const interruption = vad.push(new Float32Array(320).fill(0.1));
  if (interruption.speechStarted) backend.stopOutput();
  backend.writeOutput(new Float32Array([4]));
  await waitFor(() => streams.length === 2 && streams[1].writes.length === 1);
  await backend.close();

  assert.equal(interruption.speechStarted, true);
  assert.equal(streams[0].quitCalls, 1);
  assert.deepEqual(streams[0].writes.map((frame) => frame.readFloatLE()), [1]);
  assert.deepEqual(streams[1].writes.map((frame) => frame.readFloatLE()), [4]);
});

function createFakePortAudio() {
  const streams = [];
  class AudioIO {
    constructor(options) {
      this.options = options;
      this.handlers = new Map();
      this.started = 0;
      this.quitCalls = 0;
      this.writes = [];
      streams.push(this);
    }

    on(eventName, handler) {
      this.handlers.set(eventName, handler);
    }

    emit(eventName, value) {
      this.handlers.get(eventName)?.(value);
    }

    start() { this.started += 1; }
    quit() { this.quitCalls += 1; }
    write(frame) { this.writes.push(frame); }
  }

  return { PortAudio: { AudioIO, SampleFormat16Bit: 's16', SampleFormat32Bit: 'f32' }, streams };
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail('timed out waiting for audio operation');
}
