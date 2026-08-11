import test from 'node:test';
import assert from 'node:assert/strict';

import { createPlaybackQueue } from '../src/audio/playback-queue.mjs';

test('plays queued frames in order', async () => {
  const played = [];
  const queue = createPlaybackQueue({ writeFrame: async (frame) => played.push([...frame]) });

  queue.write(new Float32Array([1]));
  queue.write(new Float32Array([2]));
  await queue.flush();

  assert.deepEqual(played, [[1], [2]]);
});

test('stopOutput discards frames queued behind the current frame', async () => {
  const played = [];
  let releaseFirstFrame;
  const firstFrameStarted = new Promise((resolve) => { releaseFirstFrame = resolve; });
  let finishFirstFrame;
  const firstFrameFinished = new Promise((resolve) => { finishFirstFrame = resolve; });
  const queue = createPlaybackQueue({
    writeFrame: async (frame) => {
      played.push([...frame]);
      releaseFirstFrame();
      await firstFrameFinished;
    },
  });

  queue.write(new Float32Array([1]));
  queue.write(new Float32Array([2]));
  queue.write(new Float32Array([3]));
  await firstFrameStarted;
  queue.stopOutput();
  finishFirstFrame();
  await queue.flush();

  assert.deepEqual(played, [[1]]);
});

test('does not play stale audio enqueued before stopOutput', async () => {
  const played = [];
  const queue = createPlaybackQueue({ writeFrame: async (frame) => played.push([...frame]) });

  queue.write(new Float32Array([1]));
  queue.stopOutput();
  queue.write(new Float32Array([4]));
  await queue.flush();

  assert.deepEqual(played, [[4]]);
});
