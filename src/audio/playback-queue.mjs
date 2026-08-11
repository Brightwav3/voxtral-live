export function createPlaybackQueue({ writeFrame }) {
  if (typeof writeFrame !== 'function') throw new Error('writeFrame must be a function');

  let queuedFrames = [];
  let draining = false;
  let generation = 0;
  let idlePromise = Promise.resolve();
  let finishDrain = () => {};
  let failDrain = () => {};

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
    })().then(
      () => settleDrain(),
      (error) => {
        // Surface stream failures through flush() instead of leaving an
        // unhandled rejection; the queue is dropped so playback can restart.
        queuedFrames = [];
        settleDrain(error);
      },
    );
  }

  function settleDrain(error) {
    draining = false;
    const pending = queuedFrames.length > 0;
    if (error) failDrain(error);
    else finishDrain();
    if (pending) scheduleDrain();
  }

  function scheduleDrain() {
    draining = true;
    idlePromise = new Promise((resolve, reject) => { finishDrain = resolve; failDrain = reject; });
    idlePromise.catch(() => {});
    queueMicrotask(drain);
  }
}
