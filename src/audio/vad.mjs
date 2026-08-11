const DEFAULTS = {
  sampleRate: 16000,
  frameMs: 20,
  startRms: 0.02,
  stopRms: 0.015,
  startAfterMs: 60,
  stopAfterMs: 450,
  // Adaptive sensitivity: the absolute thresholds above are only a fallback.
  // When enabled the start threshold tracks the measured noise floor so quiet
  // microphones (headsets with low input gain) still trigger on normal speech.
  adaptive: true,
  startFactor: 3,
  minStartRms: 0.004,
  maxStartRms: 0.05,
  // No speech can start during calibration: protects against the burst of
  // garbage most drivers emit on the first frames after opening a stream.
  calibrationMs: 300,
  noiseFloorRiseAlpha: 0.02,
  noiseFloorFallAlpha: 0.2,
};

export const VAD_SENSITIVITY_PRESETS = {
  low: { startFactor: 4, minStartRms: 0.012, maxStartRms: 0.08 },
  medium: { startFactor: 3, minStartRms: 0.004, maxStartRms: 0.05 },
  high: { startFactor: 2.5, minStartRms: 0.0025, maxStartRms: 0.03 },
};

export function createVad(options = {}) {
  const { sensitivity, ...rest } = options;
  const preset = resolvePreset(sensitivity);
  const settings = { ...DEFAULTS, ...preset, ...rest };
  validate(settings);
  const attackFrames = Math.ceil(settings.startAfterMs / settings.frameMs);
  const releaseFrames = Math.ceil(settings.stopAfterMs / settings.frameMs);
  const calibrationFrames = Math.ceil(settings.calibrationMs / settings.frameMs);
  const stopRatio = settings.stopRms / settings.startRms;
  let state = 'silence';
  let loudFrames = 0;
  let quietFrames = 0;
  let noiseFloor = null;
  let framesSeen = 0;

  return { push, reset, thresholds, noiseFloorRms: () => noiseFloor };

  function push(frame) {
    const rms = calculateRms(frame);
    framesSeen += 1;
    let speechStarted = false;
    let speechStopped = false;
    const { start, stop } = thresholds();

    if (state === 'silence') {
      if (rms <= start) trackNoiseFloor(rms);
      const calibrating = framesSeen <= calibrationFrames;
      loudFrames = !calibrating && rms >= start ? loudFrames + 1 : 0;
      if (loudFrames >= attackFrames) {
        state = 'speech';
        loudFrames = 0;
        quietFrames = 0;
        speechStarted = true;
      }
    } else {
      quietFrames = rms <= stop ? quietFrames + 1 : 0;
      if (quietFrames >= releaseFrames) {
        state = 'silence';
        loudFrames = 0;
        quietFrames = 0;
        speechStopped = true;
      }
    }

    return { state, speechStarted, speechStopped };
  }

  function thresholds() {
    if (!settings.adaptive || noiseFloor === null) {
      return { start: settings.startRms, stop: settings.stopRms };
    }
    const start = clamp(noiseFloor * settings.startFactor, settings.minStartRms, settings.maxStartRms);
    return { start, stop: start * stopRatio };
  }

  function trackNoiseFloor(rms) {
    if (noiseFloor === null) {
      noiseFloor = rms;
      return;
    }
    const alpha = rms > noiseFloor ? settings.noiseFloorRiseAlpha : settings.noiseFloorFallAlpha;
    noiseFloor += alpha * (rms - noiseFloor);
  }

  // Clears the detector's speech state only. The calibration window and the
  // learned noise floor survive, because reset() is also called mid-stream
  // (echo suppression) where re-arming calibration would deafen the detector.
  function reset() {
    state = 'silence';
    loudFrames = 0;
    quietFrames = 0;
  }
}

function resolvePreset(sensitivity) {
  if (sensitivity === undefined) return {};
  const preset = VAD_SENSITIVITY_PRESETS[sensitivity];
  if (!preset) {
    throw new Error(`sensitivity must be one of ${Object.keys(VAD_SENSITIVITY_PRESETS).join(', ')}`);
  }
  return preset;
}

function clamp(value, minimum, maximum) {
  return Math.min(Math.max(value, minimum), maximum);
}

function calculateRms(frame) {
  if (!frame || typeof frame.length !== 'number' || frame.length === 0) return 0;
  let total = 0;
  if (Buffer.isBuffer(frame)) {
    for (let offset = 0; offset + 1 < frame.length; offset += 2) {
      const normalized = frame.readInt16LE(offset) / 32768;
      total += normalized * normalized;
    }
    return Math.sqrt(total / (frame.length / 2));
  }
  for (const sample of frame) {
    total += sample * sample;
  }
  return Math.sqrt(total / frame.length);
}

function validate(settings) {
  const positive = {
    sampleRate: settings.sampleRate,
    frameMs: settings.frameMs,
    startRms: settings.startRms,
    stopRms: settings.stopRms,
    startAfterMs: settings.startAfterMs,
    stopAfterMs: settings.stopAfterMs,
    startFactor: settings.startFactor,
    minStartRms: settings.minStartRms,
    maxStartRms: settings.maxStartRms,
    calibrationMs: settings.calibrationMs,
  };
  for (const [name, value] of Object.entries(positive)) {
    if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`);
  }
  for (const name of ['noiseFloorRiseAlpha', 'noiseFloorFallAlpha']) {
    const value = settings[name];
    if (!Number.isFinite(value) || value <= 0 || value > 1) throw new Error(`${name} must be between 0 and 1`);
  }
  if (settings.stopRms > settings.startRms) throw new Error('stopRms must be less than or equal to startRms');
  if (settings.minStartRms > settings.maxStartRms) throw new Error('minStartRms must be less than or equal to maxStartRms');
}
