const DEFAULTS = {
  inputSampleRate: 16_000,
  outputSampleRate: 24_000,
  maxDelayMs: 500,
  correlationThreshold: 0.82,
  minRms: 0.005,
};

export function createEchoSuppressor(options = {}) {
  const settings = { ...DEFAULTS, ...options };
  validate(settings);
  const maxSamples = Math.ceil(settings.inputSampleRate * settings.maxDelayMs / 1000);
  let outputReference = [];

  return { pushOutput, isPlaybackEcho, reset };

  function pushOutput(frame) {
    if (!(frame instanceof Float32Array)) throw new TypeError('echo reference output must be Float32Array');
    const resampled = resample(frame, settings.outputSampleRate, settings.inputSampleRate);
    outputReference.push(...resampled);
    if (outputReference.length > maxSamples) outputReference = outputReference.slice(-maxSamples);
  }

  function isPlaybackEcho(inputFrame) {
    const input = normalizeInput(inputFrame);
    if (input.length === 0 || outputReference.length < input.length || rms(input) < settings.minRms) return false;
    const step = Math.max(1, Math.floor(input.length / 40));
    const lastStart = outputReference.length - input.length;
    for (let start = 0; start <= lastStart; start += step) {
      if (normalizedCorrelation(input, outputReference, start) >= settings.correlationThreshold) return true;
    }
    return lastStart % step !== 0
      && normalizedCorrelation(input, outputReference, lastStart) >= settings.correlationThreshold;
  }

  function reset() {
    outputReference = [];
  }
}

function resample(input, sourceRate, targetRate) {
  if (input.length === 0) return [];
  const outputLength = Math.floor(input.length * targetRate / sourceRate);
  const output = new Array(outputLength);
  const ratio = sourceRate / targetRate;
  for (let index = 0; index < outputLength; index += 1) {
    const sourceIndex = index * ratio;
    const left = Math.floor(sourceIndex);
    const right = Math.min(input.length - 1, left + 1);
    const fraction = sourceIndex - left;
    output[index] = input[left] * (1 - fraction) + input[right] * fraction;
  }
  return output;
}

function normalizeInput(frame) {
  if (Buffer.isBuffer(frame)) {
    const samples = new Array(Math.floor(frame.length / 2));
    for (let index = 0; index < samples.length; index += 1) samples[index] = frame.readInt16LE(index * 2) / 32768;
    return samples;
  }
  if (frame instanceof Float32Array) return [...frame];
  return [];
}

function normalizedCorrelation(input, reference, start) {
  let dot = 0;
  let inputEnergy = 0;
  let referenceEnergy = 0;
  for (let index = 0; index < input.length; index += 1) {
    const left = input[index];
    const right = reference[start + index];
    dot += left * right;
    inputEnergy += left * left;
    referenceEnergy += right * right;
  }
  if (inputEnergy === 0 || referenceEnergy === 0) return 0;
  return Math.abs(dot / Math.sqrt(inputEnergy * referenceEnergy));
}

function rms(samples) {
  let energy = 0;
  for (const sample of samples) energy += sample * sample;
  return Math.sqrt(energy / samples.length);
}

function validate(settings) {
  for (const name of ['inputSampleRate', 'outputSampleRate', 'maxDelayMs', 'minRms']) {
    if (!Number.isFinite(settings[name]) || settings[name] <= 0) throw new TypeError(`${name} must be positive`);
  }
  if (!Number.isFinite(settings.correlationThreshold)
      || settings.correlationThreshold <= 0
      || settings.correlationThreshold > 1) {
    throw new TypeError('correlationThreshold must be greater than 0 and at most 1');
  }
}
