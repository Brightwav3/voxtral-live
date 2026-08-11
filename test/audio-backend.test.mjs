import test from 'node:test';
import assert from 'node:assert/strict';

import { createAudioBackend } from '../src/audio/audio-backend.mjs';
import { createFramer } from '../src/audio/portaudio-backend.mjs';
import { createVad } from '../src/audio/vad.mjs';

test('opens exact mono PCM streams and closes both streams', async () => {
  const { PortAudio, streams } = createFakePortAudio();
  const received = [];
  const backend = createAudioBackend({ inputDevice: 2, outputDevice: 7, PortAudio });

  await backend.startInput((frame) => received.push(frame));
  backend.writeOutput(new Float32Array([1, -1]));
  await waitFor(() => streams.length === 2 && streams[1].writes.length === 1);
  streams[0].emit('data', Buffer.alloc(640, 1));
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
  assert.deepEqual(received, [Buffer.alloc(640, 1)]);
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
  const vad = createVad({ startRms: 0.05, stopRms: 0.03, adaptive: false });
  for (let index = 0; index < 20; index += 1) vad.push(new Float32Array(320));

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

test('flushOutput waits until the final frame is device-drained', async () => {
  const { PortAudio, streams } = createFakePortAudio();
  const drained = deferred();
  const backend = createAudioBackend({
    PortAudio,
    waitForOutputDrain: async () => drained.promise,
  });
  backend.writeOutput(new Float32Array(480).fill(0.25));
  await waitFor(() => streams.length === 1 && streams[0].writes.length === 1);
  let flushFinished = false;

  const flushing = backend.flushOutput().then(() => { flushFinished = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(flushFinished, false);

  drained.resolve();
  await flushing;
  assert.equal(flushFinished, true);
  await backend.close();
});

test('flushOutput closes the output stream after the final frame drains', async () => {
  const { PortAudio, streams } = createFakePortAudio();
  const backend = createAudioBackend({ PortAudio });

  backend.writeOutput(new Float32Array(480).fill(0.25));
  await waitFor(() => streams.length === 1 && streams[0].writes.length === 1);
  await backend.flushOutput();

  assert.equal(streams[0].quitCalls, 1);
  await backend.close();
});


test('explains which device and sample rate the input stream rejected', async () => {
  const PortAudio = {
    SampleFormat16Bit: 's16',
    SampleFormatFloat32: 'f32',
    AudioIO: class { constructor() { throw new Error('Invalid sample rate'); } },
    getDevices: () => [{ id: 29, name: 'Headset Microphone', hostAPIName: 'Windows WASAPI', defaultSampleRate: 48000 }],
  };
  const backend = createAudioBackend({ inputDevice: 29, PortAudio });

  await assert.rejects(() => backend.startInput(() => {}), (error) => {
    assert.equal(error.code, 'audio_stream_open_failed');
    assert.equal(error.deviceId, 29);
    assert.equal(error.sampleRate, 16000);
    assert.match(error.message, /device=29 \(Headset Microphone\)/);
    assert.match(error.message, /hostApi=Windows WASAPI/);
    assert.match(error.message, /sampleRate=16000/);
    assert.match(error.message, /deviceDefaultSampleRate=48000/);
    assert.match(error.message, /rejected 16000 Hz/);
    return true;
  });
});

test('surfaces output stream failures with device details', async () => {
  const PortAudio = {
    SampleFormat16Bit: 's16',
    SampleFormatFloat32: 'f32',
    AudioIO: class { constructor() { throw new Error('Invalid sample rate'); } },
    getDevices: () => [{ id: 27, name: 'Speakers', hostAPIName: 'Windows WASAPI', defaultSampleRate: 48000 }],
  };
  const backend = createAudioBackend({ outputDevice: 27, PortAudio });
  const failures = [];

  backend.writeOutput(new Float32Array([0.1]));
  await backend.flushOutput().catch((error) => failures.push(error));

  const error = failures[0];
  assert.equal(error?.code, 'audio_stream_open_failed');
  assert.equal(error.direction, 'output');
  assert.match(error.message, /device=27 \(Speakers\)/);
  assert.match(error.message, /sampleRate=24000/);
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

  return {
    PortAudio: {
      AudioIO,
      SampleFormat16Bit: 's16',
      SampleFormatFloat32: 'f32',
      SampleFormat32Bit: 's32',
    },
    streams,
  };
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail('timed out waiting for audio operation');
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test('re-slices driver chunks into exact 20 ms input frames', () => {
  const frames = [];
  const framer = createFramer((frame) => frames.push(frame));

  framer(Buffer.alloc(1500, 1));
  assert.deepEqual(frames.map((frame) => frame.length), [640, 640]);

  framer(Buffer.alloc(500, 2));
  assert.deepEqual(frames.map((frame) => frame.length), [640, 640, 640]);
  assert.equal(frames[2][0], 1, 'the carried remainder leads the next frame');
  assert.equal(frames[2].at(-1), 2, 'the next chunk completes it');

  framer(Buffer.alloc(0));
  framer('not a buffer');
  assert.equal(frames.length, 3, 'empty and non-buffer chunks are ignored');
});

test('delivers 20 ms frames to the input handler regardless of driver chunk size', async () => {
  const { PortAudio, streams } = createFakePortAudio();
  const backend = createAudioBackend({ inputDevice: 13, PortAudio });
  const received = [];

  await backend.startInput((frame) => received.push(frame));
  streams[0].emit('data', Buffer.alloc(7529 * 2, 3));
  await backend.close();

  assert.equal(received.length, 23);
  assert.deepEqual([...new Set(received.map((frame) => frame.length))], [640]);
});
