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
  let outputClosePromise = Promise.resolve();

  return { startInput, writeOutput, stopOutput, flushOutput, close };

  async function startInput(onFrame) {
    if (typeof onFrame !== 'function') throw new Error('onFrame must be a function');
    if (closed) throw new Error('audio backend is closed');
    if (input || inputStarting) throw new Error('audio input is already starting or started');
    inputStarting = true;
    try {
      const audio = await loadPortAudio(PortAudio);
      if (closed) return;
      const nextInput = openStream(audio, 'input', INPUT_OPTIONS, inputDevice);
      if (closed) {
        nextInput.quit();
        return;
      }
      input = nextInput;
      // PortAudio delivers whatever the driver hands over — often hundreds of
      // milliseconds per event. Re-slice to exact 20 ms frames so the detector's
      // attack and release windows mean what they say.
      input.on('data', createFramer(onFrame));
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
    await resetOutput();
  }

  async function close() {
    closed = true;
    queue?.stopOutput();
    await resetOutput();
    await queue?.flush().catch(() => {});
    input?.quit();
    input = undefined;
    queue = undefined;
  }

  function createOutputQueue() {
    return createPlaybackQueue({
      writeFrame: async (frame, isCurrent) => {
        await outputClosePromise;
        const audio = await loadPortAudio(PortAudio);
        if (closed || !isCurrent()) return;
        if (!output) {
          output = openStream(audio, 'output', OUTPUT_OPTIONS, outputDevice);
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
    if (!activeOutput) return outputClosePromise;
    outputClosePromise = outputClosePromise.then(() => activeOutput.quit());
    return outputClosePromise;
  }
}

function defaultWaitForOutputDrain({ durationMs }) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Math.ceil(durationMs))));
}

export const INPUT_FRAME_BYTES = INPUT_OPTIONS.framesPerBuffer * 2;

export function createFramer(onFrame, frameBytes = INPUT_FRAME_BYTES) {
  let carry = Buffer.alloc(0);
  return (chunk) => {
    if (!Buffer.isBuffer(chunk) || chunk.length === 0) return;
    let buffer = carry.length > 0 ? Buffer.concat([carry, chunk]) : chunk;
    let offset = 0;
    while (buffer.length - offset >= frameBytes) {
      onFrame(buffer.subarray(offset, offset + frameBytes));
      offset += frameBytes;
    }
    carry = offset < buffer.length ? Buffer.from(buffer.subarray(offset)) : Buffer.alloc(0);
  };
}

export function openStream(audio, direction, options, deviceId) {
  const key = direction === 'input' ? 'inOptions' : 'outOptions';
  try {
    return new audio.AudioIO({ [key]: toAudioOptions(audio, options, deviceId) });
  } catch (error) {
    throw describeStreamError(error, { audio, direction, options, deviceId });
  }
}

function describeStreamError(error, { audio, direction, options, deviceId }) {
  const resolved = deviceId ?? -1;
  const device = findDevice(audio, resolved);
  const details = [
    `device=${resolved}${device?.name ? ` (${device.name})` : ''}`,
    device?.hostAPIName ? `hostApi=${device.hostAPIName}` : undefined,
    `sampleRate=${options.sampleRate}`,
    `channels=${options.channelCount}`,
    `format=${options.sampleFormat}`,
    device ? `deviceDefaultSampleRate=${device.defaultSampleRate}` : undefined,
  ].filter(Boolean).join(', ');
  const hint = /sample rate/i.test(error?.message ?? '')
    ? ` The device rejected ${options.sampleRate} Hz. Pick a device whose host API supports it — MME and DirectSound endpoints usually do, exclusive-mode WASAPI endpoints often do not.`
    : '';
  const wrapped = new Error(
    `Unable to open audio ${direction} stream (${details}): ${error?.message ?? error}.${hint}`,
  );
  wrapped.code = 'audio_stream_open_failed';
  wrapped.direction = direction;
  wrapped.deviceId = resolved;
  wrapped.sampleRate = options.sampleRate;
  wrapped.cause = error;
  return wrapped;
}

function findDevice(audio, deviceId) {
  if (deviceId < 0 || typeof audio.getDevices !== 'function') return undefined;
  try {
    return audio.getDevices().find((entry) => entry.id === deviceId);
  } catch {
    return undefined;
  }
}

function toAudioOptions(audio, options, deviceId) {
  const sampleFormat = options.sampleFormat === 'int16'
    ? audio.SampleFormat16Bit
    : audio.SampleFormatFloat32;
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
