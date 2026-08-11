import { createPlaybackQueue } from './playback-queue.mjs';

const INPUT_OPTIONS = {
  channelCount: 1,
  sampleFormat: 'int16',
  sampleRate: 16000,
  framesPerBuffer: 320,
};

const OUTPUT_OPTIONS = {
  channelCount: 1,
  sampleFormat: 'float32',
  sampleRate: 24000,
  framesPerBuffer: 480,
};

export function createPortAudioBackend({
  inputDevice,
  outputDevice,
  PortAudio,
  waitForOutputDrain = defaultWaitForOutputDrain,
} = {}) {
  if (typeof waitForOutputDrain !== 'function') throw new TypeError('waitForOutputDrain must be a function');
  let input;
  let output;
  let queue;
  let closed = false;
  let inputStarting = false;

  return { startInput, writeOutput, stopOutput, flushOutput, close };

  async function startInput(onFrame) {
    if (typeof onFrame !== 'function') throw new Error('onFrame must be a function');
    if (closed) throw new Error('audio backend is closed');
    if (input || inputStarting) throw new Error('audio input is already starting or started');
    inputStarting = true;
    try {
      const audio = await loadPortAudio(PortAudio);
      if (closed) return;
      const nextInput = new audio.AudioIO({
        inOptions: toAudioOptions(audio, INPUT_OPTIONS, inputDevice),
      });
      if (closed) {
        nextInput.quit();
        return;
      }
      input = nextInput;
      input.on('data', onFrame);
      input.start();
    } finally {
      inputStarting = false;
    }
  }

  function writeOutput(pcmFloat32Frame) {
    if (!(pcmFloat32Frame instanceof Float32Array)) {
      throw new Error('output frames must be Float32Array instances');
    }
    if (closed) throw new Error('audio backend is closed');
    if (!queue) queue = createOutputQueue();
    queue.write(pcmFloat32Frame);
  }

  function stopOutput() {
    queue?.stopOutput();
    resetOutput();
  }

  async function flushOutput() {
    await queue?.flush();
  }

  async function close() {
    closed = true;
    stopOutput();
    await queue?.flush();
    input?.quit();
    input = undefined;
    queue = undefined;
  }

  function createOutputQueue() {
    return createPlaybackQueue({
      writeFrame: async (frame, isCurrent) => {
        const audio = await loadPortAudio(PortAudio);
        if (closed || !isCurrent()) return;
        if (!output) {
          output = new audio.AudioIO({
            outOptions: toAudioOptions(audio, OUTPUT_OPTIONS, outputDevice),
          });
          output.start();
        }
        output.write(Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength));
        await waitForOutputDrain({
          frame,
          sampleRate: OUTPUT_OPTIONS.sampleRate,
          durationMs: frame.length / OUTPUT_OPTIONS.sampleRate * 1000,
        });
      },
    });
  }

  function resetOutput() {
    const activeOutput = output;
    output = undefined;
    activeOutput?.quit();
  }
}

function defaultWaitForOutputDrain({ durationMs }) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Math.ceil(durationMs))));
}

function toAudioOptions(audio, options, deviceId) {
  const sampleFormat = options.sampleFormat === 'int16'
    ? audio.SampleFormat16Bit
    : audio.SampleFormat32Bit;
  return {
    ...options,
    sampleFormat,
    deviceId: deviceId ?? -1,
    closeOnError: true,
  };
}

async function loadPortAudio(PortAudio) {
  if (PortAudio) return PortAudio;
  try {
    const module = await import('naudiodon2');
    return module.default ?? module;
  } catch (error) {
    throw new Error(`Unable to load naudiodon2 audio backend: ${error.message}`);
  }
}
