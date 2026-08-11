import test from 'node:test';
import assert from 'node:assert/strict';

import { createTurnController } from '../src/conversation/turn-controller.mjs';

test('does not emit turns from unstable partial transcripts', async (t) => {
  t.mock.timers.enable(['setTimeout']);
  const controller = createTurnController({ silenceMs: 550 });
  const turns = [];
  controller.on('turn', (turn) => turns.push(turn));

  controller.pushPartial('Can you');
  controller.pushPartial('Can you hear');
  t.mock.timers.tick(550);

  assert.deepEqual(turns, []);
});

test('emits exactly one turn for a final transcript', async (t) => {
  t.mock.timers.enable(['setTimeout']);
  const controller = createTurnController({ silenceMs: 550 });
  const turns = [];
  controller.on('turn', (turn) => turns.push(turn));

  controller.pushPartial('Hello there');
  controller.pushFinal('Hello there');
  t.mock.timers.tick(550);

  assert.deepEqual(turns, [{ text: 'Hello there' }]);
});

test('does not duplicate a final transcript when its silence timeout expires', async (t) => {
  t.mock.timers.enable(['setTimeout']);
  const controller = createTurnController({ silenceMs: 550 });
  const turns = [];
  controller.on('turn', (turn) => turns.push(turn));

  controller.pushFinal('One complete turn');
  t.mock.timers.tick(550);
  t.mock.timers.tick(550);

  assert.deepEqual(turns, [{ text: 'One complete turn' }]);
});

test('deduplicates a finalized transcript that arrives after it has emitted', async (t) => {
  t.mock.timers.enable(['setTimeout']);
  const controller = createTurnController({ silenceMs: 550 });
  const turns = [];
  controller.on('turn', (turn) => turns.push(turn));

  controller.pushFinal('Do not repeat this');
  t.mock.timers.tick(550);
  controller.pushFinal('Do not repeat this');
  t.mock.timers.tick(550);

  assert.deepEqual(turns, [{ text: 'Do not repeat this' }]);
});
