const DEFAULTS = {
  sampleRate: 16000,
  frameMs: 20,
  startRms: 0.02,
  stopRms: 0.015,
  startAfterMs: 60,
  stopAfterMs: 450,
};

export function createVad(options = {}) {
  const settings = { ...DEFAULTS, ...options };
  validate(settings);
  const attackFrames = Math.ceil(settings.startAfterMs / settings.frameMs);
  const releaseFrames = Math.ceil(settings.stopAfterMs / settings.frameMs);
  let state = 'silence';
  let loudFrames = 0;
  let quietFrames = 0;

  return { push, reset };

  function push(frame) {
    const rms = calculateRms(frame);
    let speechStarted = false;
    let speechStopped = false;

    if (state === 'silence') {
      loudFrames = rms >= settings.startRms ? loudFrames + 1 : 0;
      if (loudFrames >= attackFrames) {
        state = 'speech';
        loudFrames = 0;
        quietFrames = 0;
        speechStarted = true;
      }
    } else {
      quietFrames = rms <= settings.stopRms ? quietFrames + 1 : 0;
      if (quietFrames >= releaseFrames) {
        state = 'silence';
        loudFrames = 0;
        quietFrames = 0;
        speechStopped = true;
      }
    }

    return { state, speechStarted, speechStopped };
  }

  function reset() {
    state = 'silence';
    loudFrames = 0;
    quietFrames = 0;
  }
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

function validate({ sampleRate, frameMs, startRms, stopRms, startAfterMs, stopAfterMs }) {
  for (const [name, value] of Object.entries({ sampleRate, frameMs, startRms, stopRms, startAfterMs, stopAfterMs })) {
    if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`);
  }
  if (stopRms > startRms) throw new Error('stopRms must be less than or equal to startRms');
}
