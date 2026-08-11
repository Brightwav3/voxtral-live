export function createPlaybackQueue({ writeFrame }) {
  if (typeof writeFrame !== 'function') throw new Error('writeFrame must be a function');

  let queuedFrames = [];
  let draining = false;
  let generation = 0;
  let idlePromise = Promise.resolve();
  let finishDrain = () => {};

  return { write, stopOutput, flush };

  function write(frame) {
    if (!(frame instanceof Float32Array)) throw new Error('output frames must be Float32Array instances');
    queuedFrames.push({ frame, generation });
    if (!draining) scheduleDrain();
  }

  function stopOutput() {
    generation += 1;
    queuedFrames = [];
  }

  function flush() {
    return idlePromise;
  }

  function drain() {
    (async () => {
      while (queuedFrames.length > 0) {
        const entry = queuedFrames.shift();
        if (entry.generation === generation) {
          await writeFrame(entry.frame, () => entry.generation === generation);
        }
      }
    })().finally(() => {
      draining = false;
      if (queuedFrames.length > 0) {
        finishDrain();
        scheduleDrain();
      } else {
        finishDrain();
      }
    });
  }

  function scheduleDrain() {
    draining = true;
    idlePromise = new Promise((resolve) => { finishDrain = resolve; });
    queueMicrotask(drain);
  }
}
