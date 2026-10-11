import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import { test } from 'node:test';
import { loadSnapshot } from './support/load-snapshot.mjs';

// Isolated parser/transport regressions. No live provider or billable API calls.
const g = await loadSnapshot('glm');
const w = await loadSnapshot('web-search');
const request = { text: '查一下公开资料', attachments: [] };
const question = { id: 1, text: '公开资料中的事实', independentSupportRequired: false };
const source = { sourceId: 1, evidenceGroupId: 1, title: '原文', link: 'https://example.org/page', sourceKind: 'media' };
const page = { title: source.title, link: source.link, content: '这是离线回归测试使用的完整原文。' };
const evidence = { cards: [{ point: question.text, requestedPointIds: [1], finding: '有原文', evidenceScope: 'quoted-content', status: 'supported', quotes: [{ sourceId: 1, quote: page.content }] }], gaps: [], sourceDisclosures: [], reviewerNotes: [], independenceAssessments: [] };
const modelAnswer = { claims: [{ text: '来源记录了一项事实。', requestedPointIds: [1], evidenceRefs: [{ cardId: 1, quoteId: 0 }], group: 1, sourceAttribution: 'none' }], limitations: [] };
const validAnswer = JSON.stringify(modelAnswer);
const approvedPoints = [{ id: 1, text: modelAnswer.claims[0].text, requestedPointIds: [1], kind: '已核验事实或解释' }];
const validNarrative = JSON.stringify({ paragraphs: [{ claimRefs: [1] }] });
const approved = { approved: true, rejectedClaims: [], rejectedLimitations: [], issues: [] };
const parse = raw => g.parseStructuredResearchAnswer(raw, evidence, [source], [question]);
const brain = (options = {}) => new g.GlmBrain({ apiKey: 'mock', baseUrl: 'https://unused.invalid', model: 'mock', reasoningEffort: 'low', maxTokens: 3000, timeoutMs: 1000, ...options }, { instructions: '简洁' });

for (const raw of ['null', '[]', 'true', '0', '""', '', '   ']) {
  test(`structured parser rejects ${JSON.stringify(raw)} without throwing`, () => {
    assert.equal(parse(raw).ok, false);
  });
  test(`narrative parser rejects ${JSON.stringify(raw)} without throwing`, () => {
    assert.equal(g.parseResearchNarrative(raw, approvedPoints), undefined);
  });
}
for (const wrap of [value => `[${value}]`, value => `["unexpected root array", ${value}]`, value => `${value}\n${value}`]) {
  test(`structured parser refuses ambiguous wrapper ${wrap('{}')}`, () => assert.equal(parse(wrap(validAnswer)).ok, false));
  test(`narrative parser refuses ambiguous wrapper ${wrap('{}')}`, () => assert.equal(g.parseResearchNarrative(wrap(validNarrative), approvedPoints), undefined));
}
test('a single fenced JSON object remains compatible', () => {
  assert.equal(parse('```json\n' + validAnswer + '\n```').ok, true);
  assert.ok(g.parseResearchNarrative('```json\n' + validNarrative + '\n```', approvedPoints));
});
test('object extraction handles escaped quotes and braces inside strings', () => {
  const answer = structuredClone(modelAnswer);
  answer.claims[0].text = '原文使用了 "}" 与 "{" 符号。';
  assert.equal(parse('```json\n' + JSON.stringify(answer) + '\n```').ok, true);
});
test('null synthesis uses the bounded format repair instead of terminating the whole answer', async () => {
  const b = brain(); let calls = 0;
  b.complete = async () => ({ content: calls++ === 0 ? 'null' : validAnswer });
  b.auditResearchAnswer = async () => approved;
  b.expressResearchAnswer = async () => '修复后的已审答复';
  const actual = await b.finishStructuredResearchAnswer({ messages: [], toolCalls: [], text: '' }, { toolCallId: 'mock', content: '{}' }, request, evidence, [source], [question], []);
  assert.equal(actual, '修复后的已审答复'); assert.equal(calls, 2);
});
test('null factual audit receives its one format retry', async () => {
  const b = brain(); let calls = 0;
  b.auditResearchAnswerRelevance = async () => approved;
  b.complete = async () => ({ content: calls++ === 0 ? 'null' : JSON.stringify(approved) });
  const answer = parse(validAnswer).answer;
  const actual = await b.auditResearchAnswer(request, answer, evidence, [source], [question], []);
  assert.equal(actual.approved, true); assert.equal(calls, 2);
});
test('GLM null HTTP payload is a controlled response/schema error', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response('null'));
  await assert.rejects(() => brain().complete([]), error => !(error instanceof TypeError) && /JSON|schema|response/i.test(error.message));
});

const providerCases = [
  { name: 'ExaWebSearch', wrap: rows => ({ results: rows }), valid: { title: '页面', url: page.link, highlights: [page.content] }, invalid: { title: 12, text: 3 } },
  { name: 'BraveLlmContextSearch', wrap: rows => ({ grounding: { generic: rows } }), valid: { title: '页面', url: page.link, snippets: [page.content] }, invalid: { title: 12, snippets: {} } },
  { name: 'TavilyWebSearch', wrap: rows => ({ results: rows }), valid: { title: '页面', url: page.link, content: page.content }, invalid: { title: 12, content: 3 } },
  { name: 'BaiduWebSearch', wrap: rows => ({ references: rows }), valid: { title: '页面', url: page.link, content: page.content }, invalid: { title: 12, content: 3 } },
  { name: 'ZhipuWebSearch', wrap: rows => ({ search_result: rows }), valid: { title: '页面', link: page.link, content: page.content }, invalid: { title: 12, content: 3 } },
];
const provider = (name, options = {}) => new w[name]({ apiKey: 'mock', baseUrl: 'https://unused.invalid', timeoutMs: 1000, engines: ['search_pro'], ...options });
for (const spec of providerCases) {
  for (const payload of [null, []]) test(`${spec.name} rejects root ${JSON.stringify(payload)} with a controlled schema error`, async t => {
    t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify(payload)));
    await assert.rejects(() => provider(spec.name).searchWithFallback('query'), error => !(error instanceof TypeError) && /JSON|schema|response|数据|格式/i.test(error.message));
  });
  test(`${spec.name} keeps usable rows when a provider includes null or malformed rows`, async t => {
    const payload = spec.wrap([null, spec.invalid, spec.valid]);
    t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify(payload)));
    const actual = await provider(spec.name).searchWithFallback('query');
    assert.equal(actual.length, 1); assert.equal(actual[0].content, page.content);
  });
  test(`${spec.name} rejects a non-array result collection without a native TypeError`, async t => {
    t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify(spec.wrap({ wrong: 'type' }))));
    await assert.rejects(() => provider(spec.name).searchWithFallback('query'), error => !(error instanceof TypeError) && /JSON|schema|response|数据|格式/i.test(error.message));
  });
}
test('Exa unusable highlight elements do not abort another valid source', async t => {
  const payload = { results: [{ title: '无内容', url: 'https://example.org/empty', highlights: [null, '   '] }, providerCases[0].valid] };
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify(payload)));
  const actual = await provider('ExaWebSearch').searchWithFallback('query');
  assert.equal(actual.length, 1); assert.equal(actual[0].link, page.link);
});
test('Exa null contents row does not discard a valid fetched body', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ results: [null, { url: page.link, text: '这是已经取回的网页完整正文。' }] })));
  const actual = await provider('ExaWebSearch').enrichResults([page]);
  assert.equal(actual[0].fullPageFetched, true); assert.equal(actual[0].verificationContent, '这是已经取回的网页完整正文。');
});

test('the HTTP deadline remains active after headers while a real response body stalls', { timeout: 3000 }, async t => {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.write('{"results":['); // Deliberately leave the body unfinished.
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const start = performance.now();
  await assert.rejects(() => provider('ExaWebSearch', { baseUrl, timeoutMs: 100 }).searchWithFallback('query'), /abort|timeout|timed out/i);
  assert.ok(performance.now() - start < 1500, 'body read should be inside the deadline');
});

test('a stalled transport that ignores AbortSignal still returns control within its deadline', { timeout: 2000 }, async t => {
  t.mock.method(globalThis, 'fetch', async () => new Promise(() => {}));
  const result = await Promise.race([
    provider('ExaWebSearch', { timeoutMs: 50 }).searchWithFallback('query').then(() => 'resolved', () => 'rejected'),
    new Promise(resolve => setTimeout(() => resolve('hung'), 300)),
  ]);
  assert.equal(result, 'rejected');
});

test('all sequential searches consume one shared turn deadline', { timeout: 2000 }, async () => {
  let searchCalls = 0;
  const waitForAbort = signal => new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve([]); }, 45);
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    signal?.addEventListener('abort', abort, { once: true });
  });
  const b = brain({ researchTimeoutMs: 65, webSearch: { searchWithFallback(_query, signal) { searchCalls++; return waitForAbort(signal); } } });
  b.planWebSearch = async () => ({ needsSearch: true, queries: ['first query', 'second query', 'third query'], requestedPoints: [question], responseConstraints: [] });
  b.reviewSearchScope = async (_request, plan) => plan;
  const start = performance.now();
  let error;
  try { await b.reply(request); } catch (caught) { error = caught; }
  // Reporting an explicit timeout or returning a safe failure are both valid;
  // the user-visible answer must not wait for every fresh per-call budget.
  assert.ok(searchCalls <= 2, `started ${searchCalls} searches beyond the shared budget`);
  assert.ok(performance.now() - start < 1000, 'turn deadline failed to release the caller');
  if (error) assert.match(String(error), /abort|timeout|timed out|deadline|超时/i);
});


test('Exa whitespace-only contents never becomes a fetched authoritative page', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ results: [{ url: page.link, text: '   \n  ' }] })));
  const actual = await provider('ExaWebSearch').enrichResults([page]);
  assert.notEqual(actual[0].fullPageFetched, true);
  assert.equal(actual[0].content, page.content);
});

test('oversized provider JSON is rejected before it can consume an unbounded read', async t => {
  const payload = JSON.stringify({ results: [], padding: 'x'.repeat(3 * 1024 * 1024) });
  t.mock.method(globalThis, 'fetch', async () => new Response(payload));
  await assert.rejects(() => provider('ExaWebSearch').searchWithFallback('query'), /large|size|limit|exceed|bytes|上限|超出/i);
});

test('turn deadline releases the caller even when a custom search provider ignores cancellation', { timeout: 2000 }, async () => {
  const b = brain({ researchTimeoutMs: 50, webSearch: { async searchWithFallback() { return new Promise(() => {}); } } });
  b.planWebSearch = async () => ({ needsSearch: true, queries: ['query'], requestedPoints: [question], responseConstraints: [] });
  b.reviewSearchScope = async (_request, plan) => plan;
  const result = await Promise.race([
    b.reply(request).then(value => value.text, error => String(error)),
    new Promise(resolve => setTimeout(() => resolve('hung'), 300)),
  ]);
  assert.notEqual(result, 'hung');
  assert.match(result, /timeout|timed out|deadline|超时|时限|时间/i);
});

test('external cancellation releases an uncooperative provider without claiming completion', { timeout: 2000 }, async () => {
  const controller = new AbortController();
  const reason = new Error('owner cancelled this turn');
  const b = brain({ researchTimeoutMs: 1000, webSearch: { async searchWithFallback() { return new Promise(() => {}); } } });
  b.planWebSearch = async () => ({ needsSearch: true, queries: ['query'], requestedPoints: [question], responseConstraints: [] });
  b.reviewSearchScope = async (_request, plan) => plan;
  const timer = setTimeout(() => controller.abort(reason), 20);
  try {
    const result = await Promise.race([
      b.reply({ ...request, signal: controller.signal }).then(() => 'resolved', error => error),
      new Promise(resolve => setTimeout(() => resolve('hung'), 300)),
    ]);
    assert.equal(result, reason);
  } finally { clearTimeout(timer); }
});

for (const method of ['beginToolTurn', 'planWebSearchQuery']) test(`${method} forwards the caller cancellation signal into completion`, async () => {
  const b = brain(); const controller = new AbortController(); let seenSignal;
  b.complete = async (...args) => { seenSignal = args[4]; return { content: '{"query":"公开资料查询"}' }; };
  await b[method]({ ...request, signal: controller.signal }, ...(method === 'beginToolTurn' ? [[]] : []));
  assert.equal(seenSignal, controller.signal);
});

test('contextual query planning accepts the same single fenced JSON contract as research', async () => {
  const b = brain(); b.complete = async () => ({ content: '```json\n{"query":"公开资料查询"}\n```' });
  assert.equal(await b.planWebSearchQuery(request), '公开资料查询');
});

for (const spec of providerCases) test(`${spec.name} malformed optional metadata cannot crash candidate preparation`, async t => {
  const valid = { ...spec.valid };
  if (spec.name === 'ExaWebSearch') { valid.author = 3; valid.publishedDate = 123; }
  if (spec.name === 'TavilyWebSearch') valid.published_date = 123;
  if (spec.name === 'BaiduWebSearch') { valid.website = {}; valid.date = 123; }
  if (spec.name === 'ZhipuWebSearch') { valid.media = {}; valid.publish_date = 123; }
  const payload = spec.wrap([valid]);
  if (spec.name === 'BraveLlmContextSearch') payload.sources = { [page.link]: { site_name: {} } };
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify(payload)));
  const rows = await provider(spec.name).searchWithFallback('query');
  assert.equal(rows.length, 1);
  const actual = g.prepareSearchCandidate(rows[0]);
  assert.ok(actual); assert.equal(actual.content, page.content);
  for (const name of ['author', 'media', 'publishDate']) assert.ok(actual[name] === undefined || typeof actual[name] === 'string');
});
