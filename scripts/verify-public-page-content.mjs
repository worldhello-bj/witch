// Opt-in read-only public transport + local Contents-processing verification.
// This never contacts Exa, GLM, any paid API, or arbitrary user-supplied URLs.
// Run: node scripts/verify-public-page-content.mjs
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { loadSnapshot } from '../tests/support/load-snapshot.mjs';

const SOURCE_URL = 'https://www.rfc-editor.org/rfc/rfc9110.txt';
const MAX_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 15_000;
const realFetch = globalThis.fetch;
const started = Date.now();
// Fixed HTTPS publisher URL, no dynamic host, no credentials, no redirects.
// This is a validation utility, deliberately not a production page crawler.
const response = await realFetch(SOURCE_URL, {
  redirect: 'error',
  credentials: 'omit',
  headers: { accept: 'text/plain' },
  signal: AbortSignal.timeout(TIMEOUT_MS),
});
assert.equal(response.status,200,'public RFC source must return HTTP 200');
assert.match(response.headers.get('content-type') ?? '',/^text\/plain(?:;|$)/i);
const declared = Number(response.headers.get('content-length'));
assert.ok(!Number.isFinite(declared) || declared <= MAX_BYTES,'declared body exceeds byte budget');
assert.ok(response.body,'public source returned no response body');
const reader = response.body.getReader();
const chunks = [];
let byteLength = 0;
try {
  while (true) {
    const {value,done} = await reader.read();
    if (done) break;
    byteLength += value.byteLength;
    if (byteLength > MAX_BYTES) {
      await reader.cancel('public verification byte limit');
      throw new Error('public verification exceeded byte budget');
    }
    chunks.push(Buffer.from(value));
  }
} finally { reader.releaseLock(); }
const bytes = Buffer.concat(chunks);
const text = bytes.toString('utf8');
assert.match(text,/HTTP Semantics/,'download is not the expected RFC document');
assert.ok(text.length > 12000,'RFC fixture should exercise the truncation boundary');

const {ExaWebSearch} = await loadSnapshot('web-search');
let mockCalls = 0;
globalThis.fetch = async (url,init) => {
  assert.equal(String(url),'https://api.exa.ai/contents');
  const request = JSON.parse(init.body);
  assert.deepEqual(request.urls,[SOURCE_URL]);
  mockCalls++;
  return new Response(JSON.stringify({
    results:[{id:SOURCE_URL,url:SOURCE_URL,title:'RFC 9110: HTTP Semantics',text}],
    statuses:[{id:SOURCE_URL,status:'success'}],
  }),{status:200,headers:{'content-type':'application/json'}});
};
let result;
try {
  const provider = new ExaWebSearch({apiKey:'OFFLINE_MOCK_ONLY',timeoutMs:1000});
  result = await provider.enrichResults([
    {title:'RFC 9110',link:`${SOURCE_URL}#section-1`,content:'Independent query-specific excerpt.'},
    {title:'RFC 9110 duplicate',link:`${SOURCE_URL}#section-2`,content:'Another query-specific excerpt.'},
  ]);
} finally { globalThis.fetch = realFetch; }
assert.equal(mockCalls,1);
assert.equal(result[0].verificationContent,text.slice(0,12000).trim());
assert.equal(result[1].verificationContent,result[0].verificationContent);
assert.equal(result[0].content,'Independent query-specific excerpt.');
assert.equal(result[0].pageContentStatus,'truncated');
assert.equal(result[0].fullPageFetched,true);
console.log(JSON.stringify({
  checkedAt:new Date().toISOString(),
  publicSource:SOURCE_URL,
  realPublicHttpStatus:response.status,
  downloadedBytes:byteLength,
  downloadedSha256:createHash('sha256').update(bytes).digest('hex'),
  retainedCharacters:result[0].verificationContent.length,
  equivalentLinksEnriched:result.length,
  pageContentStatus:result[0].pageContentStatus,
  durationMs:Date.now()-started,
  actualExaCalls:0,
  actualModelCalls:0,
  scope:'Real public RFC download; Exa response and API transport are mocked; source binding and text processing are actual application code.',
},null,2));
