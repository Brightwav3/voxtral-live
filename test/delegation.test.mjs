import test from 'node:test';
import assert from 'node:assert/strict';

import {
  WEB_SEARCH_TOOL,
  createWebSearchProvider,
  validateWebSearchInput,
} from '../src/providers/web-search.mjs';
import {
  createDelegationManager,
  toSpeechText,
} from '../src/conversation/delegation.mjs';

test('defines and validates the app-owned web_search tool arguments', () => {
  assert.equal(WEB_SEARCH_TOOL.function.name, 'web_search');
  assert.deepEqual(validateWebSearchInput({ query: '  current Node release  ', recencyDays: 30 }), {
    query: 'current Node release',
    recencyDays: 30,
  });
  assert.throws(() => validateWebSearchInput({ query: '' }), /query/i);
  assert.throws(() => validateWebSearchInput({ query: 'Node', recencyDays: 0 }), /recencyDays/i);
  assert.throws(() => validateWebSearchInput({ query: 'Node', extra: true }), /unsupported/i);
});

test('search provider returns only normalized result fields and strips raw HTML', async () => {
  const provider = createWebSearchProvider({
    async searchImpl(request) {
      assert.deepEqual(request, { query: 'Voxtral', recencyDays: 7, signal: undefined });
      return [{
        title: '<b>Voxtral</b> release',
        url: 'https://example.test/voxtral',
        snippet: '<p>New <em>speech</em> model.</p>',
        publishedAt: '2026-08-10T12:00:00Z',
        rawHtml: '<html>must not escape</html>',
        score: 0.99,
      }];
    },
  });

  assert.deepEqual(await provider.search({ query: 'Voxtral', recencyDays: 7 }), [{
    title: 'Voxtral release',
    url: 'https://example.test/voxtral',
    snippet: 'New speech model.',
    publishedAt: '2026-08-10T12:00:00.000Z',
  }]);
});

test('acknowledges immediately and discards a delegated result after a newer turn', async () => {
  const searchStarted = deferred();
  const releaseSearch = deferred();
  let workerSignal;
  const events = [];
  const manager = createDelegationManager({
    conversationId: 'c_1',
    emit: (event) => events.push(event),
    webSearch: async ({ signal }) => {
      workerSignal = signal;
      searchStarted.resolve();
      await releaseSearch.promise;
      return [resultFixture()];
    },
  });
  manager.beginTurn('t_1');

  const job = manager.delegateWebSearch({ turnId: 't_1', query: 'latest model' });
  assert.deepEqual(events, [{
    event: 'assistant_acknowledgement',
    conversationId: 'c_1',
    turnId: 't_1',
    text: "I'll look that up.",
  }]);
  await searchStarted.promise;
  manager.beginTurn('t_2');
  assert.equal(workerSignal.aborted, true);
  releaseSearch.resolve();

  assert.deepEqual(await job.result, {
    status: 'discarded',
    conversationId: 'c_1',
    turnId: 't_1',
    results: [],
    citations: [],
  });
});

test('returns citations for the current turn while speech text omits raw URLs', async () => {
  const manager = createDelegationManager({
    conversationId: 'c_1',
    webSearch: async () => [resultFixture()],
  });
  manager.beginTurn('t_7');

  const { result } = manager.delegateWebSearch({ turnId: 't_7', query: 'Voxtral docs', recencyDays: 10 });
  assert.deepEqual(await result, {
    status: 'completed',
    conversationId: 'c_1',
    turnId: 't_7',
    results: [resultFixture()],
    citations: [{
      title: 'Voxtral docs',
      url: 'https://example.test/voxtral',
      publishedAt: '2026-08-10T12:00:00Z',
    }],
  });
  assert.equal(
    toSpeechText('Read [Voxtral docs](https://example.test/voxtral) or https://example.test/raw now.'),
    'Read Voxtral docs or now.',
  );
});

function resultFixture() {
  return {
    title: 'Voxtral docs',
    url: 'https://example.test/voxtral',
    snippet: 'Official documentation.',
    publishedAt: '2026-08-10T12:00:00Z',
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
