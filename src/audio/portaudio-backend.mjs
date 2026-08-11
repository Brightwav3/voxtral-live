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

export function createPortAudioBackend({ inputDevice, outputDevice, PortAudio } = {}) {
  let input;
  let output;
  let queue;

  return { startInput, writeOutput, stopOutput, close };

  async function startInput(onFrame) {
    if (typeof onFrame !== 'function') throw new Error('onFrame must be a function');
    if (input) throw new Error('audio input has already started');
    const audio = await loadPortAudio(PortAudio);
    input = new audio.AudioIO({
      inOptions: toAudioOptions(audio, INPUT_OPTIONS, inputDevice),
    });
    input.on('data', onFrame);
    input.start();
  }

  function writeOutput(pcmFloat32Frame) {
    if (!(pcmFloat32Frame instanceof Float32Array)) {
      throw new Error('output frames must be Float32Array instances');
    }
    if (!queue) queue = createOutputQueue();
    queue.write(pcmFloat32Frame);
  }

  function stopOutput() {
    queue?.stopOutput();
  }

  async function close() {
    stopOutput();
    await queue?.flush();
    input?.quit();
    output?.quit();
    input = undefined;
    output = undefined;
    queue = undefined;
  }

  function createOutputQueue() {
    return createPlaybackQueue({
      writeFrame: async (frame) => {
        const audio = await loadPortAudio(PortAudio);
        if (!output) {
          output = new audio.AudioIO({
            outOptions: toAudioOptions(audio, OUTPUT_OPTIONS, outputDevice),
          });
          output.start();
        }
        output.write(Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength));
      },
    });
  }
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
