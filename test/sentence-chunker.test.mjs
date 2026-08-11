import test from 'node:test';
import assert from 'node:assert/strict';

import { createSentenceChunker } from '../src/conversation/sentence-chunker.mjs';

test('returns complete sentences when punctuation arrives', () => {
  const chunker = createSentenceChunker();

  assert.deepEqual(chunker.push('Hello there. How are'), ['Hello there.']);
  assert.deepEqual(chunker.push(' you?'), ['How are you?']);
});

test('splits a long clause at a word boundary', () => {
  const chunker = createSentenceChunker({ maxChars: 20 });

  assert.deepEqual(chunker.push('This answer has a long clause without punctuation'), [
    'This answer has a',
    'long clause without',
  ]);
  assert.deepEqual(chunker.flush(), ['punctuation']);
});

test('does not split common abbreviations as sentences', () => {
  const chunker = createSentenceChunker();

  assert.deepEqual(chunker.push('Dr. Novák is here. Ready.'), ['Dr. Novák is here.', 'Ready.']);
});

test('flushes the final unpunctuated text once', () => {
  const chunker = createSentenceChunker();
  chunker.push('The answer trails off');

  assert.deepEqual(chunker.flush(), ['The answer trails off']);
  assert.deepEqual(chunker.flush(), []);
});
