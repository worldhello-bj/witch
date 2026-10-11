import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadSnapshot } from './support/load-snapshot.mjs';
const { ExaWebSearch } = await loadSnapshot('web-search');
const page = (link = 'https://example.org/article', extra = {}) => ({title:'Original source',link,content:'Original query-specific excerpt',...extra});
const body = 'This is the fetched page body, with a directly stated fact.';
const provider = () => new ExaWebSearch({apiKey:'offline-mock-key',timeoutMs:1000});
async function contents(t, response, sources, expectedCalls = 1) {
  const calls = [];
  t.mock.method(globalThis,'fetch',async (url,init) => {
    calls.push({url:String(url),...JSON.parse(init.body)});
    return new Response(JSON.stringify(response),{status:200});
  });
  const results = await provider().enrichResults(sources);
  assert.equal(calls.length,expectedCalls);
  return {results,calls};
}

test('contents matches URL normalization without dropping a fragment-linked body',async t=>{
  const source=page('https://EXAMPLE.org:443/article#details');
  const {results,calls}=await contents(t,{results:[{url:'https://example.org/article',text:body}]},[source]);
  assert.deepEqual(calls[0].urls,['https://example.org/article']);
  assert.equal(results[0].verificationContent,body);
  assert.equal(results[0].link,source.link);
  assert.equal(results[0].content,source.content);
  assert.equal(results[0].fullPageFetched,true);
  assert.equal(results[0].pageContentStatus,'available');
});
test('equivalent URLs use one request slot and enrich every duplicate',async t=>{
  const sources=[page('https://example.org/article#one'),page('https://EXAMPLE.org:443/article#two')];
  const {results,calls}=await contents(t,{results:[{url:'https://example.org/article',text:body}]},sources);
  assert.deepEqual(calls[0].urls,['https://example.org/article']);
  assert.ok(results.every(source=>source.verificationContent===body));
});
test('request budget counts distinct pages, not eight fragments of one page',async t=>{
  const sources=[...Array.from({length:8},(_,i)=>page(`https://example.org/article#${i}`)),page('https://example.org/important')];
  const {calls}=await contents(t,{results:[]},sources);
  assert.deepEqual(calls[0].urls,['https://example.org/article','https://example.org/important']);
});
test('only eight distinct pages are fetched and other sources stay unchanged',async t=>{
  const sources=Array.from({length:10},(_,i)=>page(`https://example.org/${i}`));
  const {results,calls}=await contents(t,{results:[]},sources);
  assert.equal(calls[0].urls.length,8);
  assert.equal(results[7].pageContentStatus,'unavailable');
  assert.equal(results[8],sources[8]);
});
for(const text of ['', ' \n\t\r ', '\u200b\u200c\u200d\ufeff', '\u0000\b\u001b\u007f']) test(`empty body is not a fetched full page: ${JSON.stringify(text)}`,async t=>{
  const {results}=await contents(t,{results:[{url:'https://example.org/article',text}]},[page()]);
  assert.equal(results[0].pageContentStatus,'empty');
  assert.equal(results[0].fullPageFetched,false);
  assert.equal(results[0].verificationContent,undefined);
  assert.equal(results[0].content,page().content);
});
test('a stale fetched flag without body no longer suppresses the contents request',async t=>{
  const {results}=await contents(t,{results:[{url:'https://example.org/article',text:body}]},[page(undefined,{fullPageFetched:true,verificationContent:'   '})]);
  assert.equal(results[0].verificationContent,body);
});
test('an already retrieved nonempty body is not fetched again',async t=>{
  const source=page(undefined,{fullPageFetched:true,verificationContent:body,pageContentStatus:'available'});
  const {results}=await contents(t,{results:[]},[source],0);
  assert.equal(results[0],source);
});
for(const size of [11999,12000,12001]) test(`body limit is truthful at ${size} characters`,async t=>{
  const {results,calls}=await contents(t,{results:[{url:'https://example.org/article',text:'字'.repeat(size)}]},[page()]);
  assert.equal(calls[0].text.maxCharacters,12000);
  assert.equal(results[0].verificationContent.length,Math.min(size,12000));
  assert.equal(results[0].pageContentStatus,size>=12000?'truncated':'available');
  assert.equal(results[0].fullPageFetched,true);
});
test('a body that hits its provider limit remains truncated after trimming outer whitespace',async t=>{
  const {results}=await contents(t,{results:[{url:'https://example.org/article',text:' '+body+' '.repeat(12000-body.length-1)}]},[page()]);
  assert.equal(results[0].pageContentStatus,'truncated');
  assert.equal(results[0].verificationContent,body);
});
test('partial HTTP-200 failure does not discard the other page or accept failed text',async t=>{
  const {results}=await contents(t,{results:[{url:'https://example.org/article',text:body},{url:'https://example.org/failed',text:'An error template must not count as a successful body.'}],statuses:[{id:'https://example.org/article',status:'success'},{id:'https://example.org/failed',status:'error',error:{tag:'CRAWL_TIMEOUT'}}]},[page(),page('https://example.org/failed')]);
  assert.equal(results[0].pageContentStatus,'available');
  assert.equal(results[1].pageContentStatus,'unavailable');
  assert.equal(results[1].fullPageFetched,false);
  assert.equal(results[1].verificationContent,undefined);
});
test('missing results have an explicit unavailable outcome',async t=>{
  const {results}=await contents(t,{results:[]},[page()]);
  assert.equal(results[0].pageContentStatus,'unavailable');
  assert.equal(results[0].content,page().content);
});
test('unexpected response entries are ignored independently',async t=>{
  const {results}=await contents(t,{results:[null,17,{url:'https://example.org/article',text:42},{url:'https://example.org/article',text:body}],statuses:[null,42]},[page()]);
  assert.equal(results[0].verificationContent,body);
});
test('an empty duplicate response cannot overwrite already usable body text',async t=>{
  const {results}=await contents(t,{results:[{url:'https://example.org/article',text:body},{url:'https://example.org/article',text:' '}]},[page()]);
  assert.equal(results[0].verificationContent,body);
});
test('an explicit matching document id can bind a same-origin redirected page',async t=>{
  const {results}=await contents(t,{results:[{id:'https://example.org/article',url:'https://example.org/article/',text:body}]},[page()]);
  assert.equal(results[0].verificationContent,body);
});
test('cross-origin redirected text is not attributed to the original publisher',async t=>{
  const {results}=await contents(t,{results:[{id:'https://example.org/article',url:'https://unrelated.org/article',text:body}]},[page()]);
  assert.equal(results[0].pageContentStatus,'unavailable');
  assert.equal(results[0].verificationContent,undefined);
});
test('response position never binds unrequested pages to a requested source',async t=>{
  const {results}=await contents(t,{results:[{url:'https://example.org/different',text:body}]},[page()]);
  assert.equal(results[0].pageContentStatus,'unavailable');
});
test('distinct query parameters and paths are not merged by URL matching',async t=>{
  const sources=[page('https://example.org/article?version=1'),page('https://example.org/article?version=2'),page('https://example.org/article/')];
  const {results,calls}=await contents(t,{results:[{url:'https://example.org/article?version=1',text:body}]},sources);
  assert.equal(calls[0].urls.length,3);
  assert.equal(results[0].pageContentStatus,'available');
  assert.equal(results[1].pageContentStatus,'unavailable');
  assert.equal(results[2].pageContentStatus,'unavailable');
});
test('credentialed, non-HTTPS and oversized URLs are not transmitted',async t=>{
  const sources=[page('https://user:secret@example.org/article'),page('http://example.org/article'),page('file:///etc/passwd'),page('https://example.org/'+ 'x'.repeat(2048))];
  const {results}=await contents(t,{results:[]},sources,0);
  assert.equal(results.length,sources.length);
});
test('contents cancellation stops before contacting the provider',async t=>{
  let calls=0;t.mock.method(globalThis,'fetch',async()=>{calls++;return new Response('{"results":[]}');});
  const controller=new AbortController();controller.abort(new Error('owner cancelled'));
  await assert.rejects(provider().enrichResults([page()],controller.signal),/owner cancelled/);
  assert.equal(calls,0);
});

const {GlmBrain,selectPageEvidenceExcerpt}=await loadSnapshot('glm');
const reviewResult=quote=>({cards:[{point:'Retrieved fact',requestedPointIds:[1],finding:'The page states the fact.',evidenceScope:'quoted-content',status:'supported',quotes:[{sourceId:1,quote}]}],gaps:[],reviewerNotes:[],sourceDisclosures:[],independenceAssessments:[],followupQueries:[]});
function reviewer() {
  return new GlmBrain({apiKey:'offline-mock',baseUrl:'https://unused.invalid',model:'mock',reasoningEffort:'low',maxTokens:1000,timeoutMs:1000},{instructions:'Be concise.'});
}
test('evidence model receives and verifies the fetched-body fact absent from search excerpts',async()=>{
  const quote='The fetched-only launch date is 2026-10-11.';
  const brain=reviewer();
  let received;
  brain.complete=async messages=>{
    received=JSON.parse(messages.find(message=>message.role==='user').content).sources[0];
    return {content:JSON.stringify(reviewResult(quote))};
  };
  const source=page(undefined,{verificationContent:quote,fullPageFetched:true,pageContentStatus:'available'});
  const result=await brain.reviewWebEvidence({text:'What is the fetched-only launch date?',attachments:[]},['fetched-only launch'],[source],[{id:1,text:'Launch date',independentSupportRequired:false}],[]);
  assert.ok(received.pageContentExcerpt.includes(quote));
  assert.equal(received.content,source.content);
  assert.equal(received.pageContentExcerptIsPartial,false);
  assert.equal(result.evidence.cards[0].status,'supported');
  assert.equal(result.evidence.cards[0].quotes[0].quote,quote);
});
test('later body windows are available to review with explicit partial/truncated boundaries',async()=>{
  const quote='The fetched-only launch date is 2026-10-11.';
  const raw='Irrelevant filler. '.repeat(390)+quote+' More irrelevant filler.'.repeat(300);
  const source=page(undefined,{verificationContent:raw.slice(0,12000),fullPageFetched:true,pageContentStatus:'truncated'});
  const brain=reviewer();
  let received;
  brain.complete=async messages=>{
    received=JSON.parse(messages.find(message=>message.role==='user').content).sources[0];
    return {content:JSON.stringify(reviewResult(quote))};
  };
  const result=await brain.reviewWebEvidence({text:'What is the fetched-only launch date?',attachments:[]},['fetched-only launch date'],[source],[{id:1,text:'Launch date',independentSupportRequired:false}],[]);
  assert.ok(received.pageContentExcerpt.includes(quote));
  assert.ok(received.pageContentExcerpt.length<=4000);
  assert.equal(received.pageContentStatus,'truncated');
  assert.equal(received.pageContentExcerptIsPartial,true);
  assert.equal(result.evidence.cards[0].status,'supported');
});
test('inserted omission markers cannot become supposedly verbatim source evidence',async()=>{
  const raw='A'.repeat(12000);
  const excerpt=selectPageEvidenceExcerpt(raw,[]);
  const marker=excerpt.indexOf('\n[正文片段省略]\n');
  assert.ok(marker>=0);
  const fabricated=excerpt.slice(marker-12,marker+24);
  assert.ok(!raw.includes(fabricated));
  const brain=reviewer();brain.complete=async()=>({content:JSON.stringify(reviewResult(fabricated))});
  const result=await brain.reviewWebEvidence({text:'What does the page say?',attachments:[]},['page'],[page(undefined,{verificationContent:raw,fullPageFetched:true,pageContentStatus:'truncated'})],[{id:1,text:'Page fact',independentSupportRequired:false}],[]);
  assert.equal(result.evidence.cards[0].status,'insufficient');
  assert.deepEqual(result.evidence.cards[0].quotes,[]);
});

test('empty highlights without fallback text cannot crash the whole Exa search',async t=>{
  t.mock.method(globalThis,'fetch',async()=>new Response(JSON.stringify({results:[
    {title:'Empty',url:'https://example.org/empty',highlights:['']},
    {title:'Useful',url:'https://example.org/useful',highlights:[body]},
  ]})));
  const results=await provider().searchWithFallback('query');
  assert.equal(results.length,1);
  assert.equal(results[0].content,body);
});
test('whitespace highlights cannot hide usable extracted text',async t=>{
  t.mock.method(globalThis,'fetch',async()=>new Response(JSON.stringify({results:[
    {title:'Useful',url:'https://example.org/useful',highlights:['  ','\n\t'],text:body},
  ]})));
  const results=await provider().searchWithFallback('query');
  assert.equal(results.length,1);
  assert.equal(results[0].content,body);
});
test('malformed Exa highlights are isolated from valid source passages',async t=>{
  t.mock.method(globalThis,'fetch',async()=>new Response(JSON.stringify({results:[
    null,
    {title:'Malformed',url:'https://example.org/malformed',highlights:[null,42,{}]},
    {title:'Useful',url:'https://example.org/useful',highlights:[body,null,'']},
  ]})));
  const results=await provider().searchWithFallback('query');
  assert.equal(results.length,1);
  assert.equal(results[0].content,body);
});
