import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadSnapshot } from './support/load-snapshot.mjs';
const g = await loadSnapshot('glm', ['mergeSearchResultPassages', 'sourceVerificationText', 'renderResearchAnswer', 'mergeTargetedAnswerRepair']);
const w = await loadSnapshot('web-search');
const source = id => ({sourceId:id,evidenceGroupId:id,title:`页面${id}`,link:`https://example.org/${id}`,sourceKind:'media'});
const sources = [1,2,3,4,5].map(source);
const quote = '这是用于离线回归测试的完整逐字原文。';
const card = (id=1,sourceId=1) => ({point:`问项${id}`,requestedPointIds:[id],finding:'索引',evidenceScope:'quoted-content',status:'supported',quotes:[{sourceId,quote}]});
const gap = id => ({point:`問项${id}`,requestedPointIds:[id],finding:'本轮无法核实',evidenceScope:'retrieval-limit',status:'insufficient',quotes:[]});
const evidence = cards => ({cards,gaps:[],sourceDisclosures:[],reviewerNotes:[],independenceAssessments:[]});
const point = (id=1,independentSupportRequired=false) => ({id,text:`问题${id}`,independentSupportRequired});
const ref = cardId => ({cardId,quoteId:0});
const claim = (text='来源已支持的事实。',ids=[1],refs=[ref(1)]) => ({text,requestedPointIds:ids,evidenceRefs:refs,group:1,sourceAttribution:'none'});
const limitation = (extra={}) => ({text:'本轮无法核实此事。',requestedPointIds:[1],cardIds:[2],group:1,...extra});
const parse = (claims, e=evidence([card()]), limitations=[],requestedPoints=[point()],requireCoverage=true) => g.parseStructuredResearchAnswer(JSON.stringify({claims,limitations}),e,sources,requestedPoints,requireCoverage,[0]);
const newBrain = () => new g.GlmBrain({apiKey:'mock',baseUrl:'https://unused.invalid',model:'mock',reasoningEffort:'low',maxTokens:1000,timeoutMs:1000},{instructions:'简洁'});

for (const injected of ['事实。[2]','事实。来源2','事实。[媒体平台来源2]','[伪造](https://fake.invalid/)','https://fake.invalid/','[伪造](/relative)','[伪造][label]','<a href="//fake.invalid">链接</a>']) {
 test(`rejects model-authored citation/link: ${injected}`,()=>assert.equal(parse([claim(injected)]).ok,false));
}
test('model-authored citation/link in a limitation is also discarded',()=>{
 assert.equal(parse([],evidence([card(),gap(1)]),[limitation({text:'无法核实。[1]'})]).ok,false);
});
test('all five cited sources remain visible instead of truncating the last source',()=>{
 const e=evidence(sources.map(s=>card(1,s.sourceId)));
 const result=parse([claim('多个被逐条引用的材料。',[1],sources.map(s=>ref(s.sourceId)))],e);
 assert.equal(result.ok,true); assert.deepEqual(result.answer.claims[0].sourceIds,[1,2,3,4,5]);
 assert.match(g.renderResearchAnswer(result.answer,e,sources),/https:\/\/example.org\/5/);
});
test('gap-only answer does not advertise unrelated supported sources as citations',()=>{
 const e=evidence([card(),gap(1)]);const result=parse([],e,[limitation()]);
 assert.equal(result.ok,true);const text=g.renderResearchAnswer(result.answer,e,sources);
 assert.doesNotMatch(text,/来源索引|https:\/\//);
});
test('source title cannot manufacture a Markdown link and target parentheses are encoded',()=>{
 const e=evidence([card()]);const result=parse([claim()],e);
 const hostile=[{...sources[0],title:'正常](https://fake.invalid/) [',link:'https://example.org/page_(v1)'}];
 const text=g.renderResearchAnswer(result.answer,e,hostile);
 assert.ok(text.includes('正常\\]\\(https://fake\\.invalid/\\) \\['));
 assert.match(text,/page_%28v1%29/); assert.doesNotMatch(text,/\]\(https:\/\/fake\.invalid/);
});
test('sixth follow-up excerpt survives with provider provenance and a bounded display',()=>{
 const old={title:'page',link:sources[0].link,content:'旧摘录',searchExcerpts:Array.from({length:5},(_,i)=>({query:`q${i}`,provider:'exa',text:`旧摘录${i}`}))};
 const fresh={...old,content:'新增决定性原文',searchExcerpts:[{query:'follow-up',provider:'brave',text:'新增决定性原文'}]};
 const merged=g.mergeSearchResultPassages(old,fresh);
 assert.ok(merged.searchExcerpts.some(x=>x.query==='follow-up'&&x.provider==='brave'));
 assert.match(merged.content,/新增决定性原文/);assert.match(g.sourceVerificationText(merged),/新增决定性原文/);
 assert.ok(merged.content.length<=3000);
});
test('excerpt bounds retain newest information and fetched page remains authoritative',()=>{
 const old={title:'page',link:sources[0].link,content:'旧摘录',verificationContent:'真实网页正文。',fullPageFetched:true,searchExcerpts:Array.from({length:15},(_,i)=>({query:`q${i}`,provider:'exa',text:`旧摘录${i}`}))};
 const merged=g.mergeSearchResultPassages(old,{...old,verificationContent:undefined,searchExcerpts:[{query:'new',provider:'brave',text:'新摘录'}]});
 assert.equal(merged.searchExcerpts.length,15);assert.equal(merged.searchExcerpts.at(-1).query,'new');
 assert.equal(g.sourceVerificationText(merged),'真实网页正文。');
});
const page={title:'page',link:sources[0].link,content:quote};
const review = (cards,assessments=[])=>({cards,gaps:[],reviewerNotes:[],sourceDisclosures:[],followupQueries:[],independenceAssessments:assessments});
test('multi-question evidence card is repaired, never cloned onto both questions',async()=>{
 const brain=newBrain();let calls=0;
 brain.complete=async()=>({content:JSON.stringify(calls++===0?review([{...card(),requestedPointIds:[1,2]}]):review([card(),gap(2)]))});
 const result=await brain.reviewWebEvidence({text:'问题',attachments:[]},['q'],[page],[point(1),point(2)],[]);
 assert.equal(calls,2);assert.deepEqual(result.evidence.cards.map(c=>c.requestedPointIds),[[1],[2]]);
});
test('repeated multi-question card fails closed after the one bounded repair',async()=>{
 const brain=newBrain();let calls=0;brain.complete=async()=>{calls++;return {content:JSON.stringify(review([{...card(),requestedPointIds:[1,2]}]))};};
 await assert.rejects(()=>brain.reviewWebEvidence({text:'问题',attachments:[]},['q'],[page],[point(1),point(2)],[]),/after one format repair/);assert.equal(calls,2);
});
for(const ids of [[],[1]]) test(`independence uncertainty admits ${ids.length} actual sources without fabricating another`,async()=>{
 const brain=newBrain();let calls=0;
 brain.complete=async()=>{calls++;return {content:JSON.stringify(review([gap(1)],[{requestedPointId:1,sourceIds:ids,status:'uncertain',rationale:'本轮没有足够资料，无法确认来源独立。'}]))};};
 const result=await brain.reviewWebEvidence({text:'独立印证',attachments:[]},['q'],[page],[point(1,true)],[]);
 assert.equal(calls,1);assert.deepEqual(result.evidence.independenceAssessments[0].sourceIds,ids);
});
test('one source still cannot masquerade as an independent pair',async()=>{
 const brain=newBrain();brain.complete=async()=>({content:JSON.stringify(review([card()],[{requestedPointId:1,sourceIds:[1,1],status:'independent',rationale:'重复引用同一页面仍不应算两个来源。'}]))});
 await assert.rejects(()=>brain.reviewWebEvidence({text:'独立印证',attachments:[]},['q'],[page],[point(1,true)],[]),/after one format repair/);
});
test('rejected claim may explicitly downgrade to a real insufficient-card limitation',()=>{
 const e=evidence([card(),gap(1)]);const original=parse([claim()],e).answer.claims[0];
 const replacement=parse([],e,[limitation({repairTargetOriginalIndex:0,repairTargetKind:'claim'})],[point()],false);
 assert.equal(replacement.ok,true);
 const plan={preservedClaims:[],preservedLimitations:[],rejectedClaims:[{originalIndex:0,claim:original}],rejectedLimitations:[]};
 const result=g.mergeTargetedAnswerRepair(plan,replacement.answer,[point()]);assert.equal(result.ok,true);
 assert.equal(result.answer.claims.length,0);assert.equal(result.answer.limitations.length,1);
 assert.equal(result.answer.limitations[0].repairTargetKind,undefined);
});
test('claim-to-gap downgrade requires an explicit kind; matching numeric index is insufficient',()=>{
 const e=evidence([card(),gap(1)]);const original=parse([claim()],e).answer.claims[0];
 const replacement=parse([],e,[limitation({repairTargetOriginalIndex:0})],[point()],false);
 const result=g.mergeTargetedAnswerRepair({preservedClaims:[],preservedLimitations:[],rejectedClaims:[{originalIndex:0,claim:original}],rejectedLimitations:[]},replacement.answer,[point()]);
 assert.equal(result.ok,false);
});
test('downgrade to supported card is rejected instead of laundering a fact as a gap',()=>{
 assert.equal(parse([],evidence([card()]),[limitation({cardIds:[1],repairTargetOriginalIndex:0,repairTargetKind:'claim'})],[point()],false).ok,false);
});
test('composite provider abort is not degraded to partial success',async()=>{
 const controller=new AbortController();const reason=new Error('cancel');
 const provider=new w.ExaBraveWebSearch({async searchWithFallback(){return [page];}},{async searchWithFallback(){controller.abort(reason);throw reason;}});
 await assert.rejects(()=>provider.searchWithFallback('q',controller.signal),/cancel/);
});
test('already-cancelled composite invokes no provider',async()=>{
 const controller=new AbortController();controller.abort(new Error('cancel'));let calls=0;
 const provider=new w.ExaBraveWebSearch({async searchWithFallback(){calls++;return [page];}},{async searchWithFallback(){calls++;return [page];}});
 await assert.rejects(()=>provider.searchWithFallback('q',controller.signal),/cancel/);assert.equal(calls,0);
});
test('Zhipu stops engine fallback when the owner cancels',async()=>{
 const controller=new AbortController();const reason=new Error('cancel');let calls=0;
 const provider=new w.ZhipuWebSearch({apiKey:'mock',baseUrl:'https://unused.invalid',timeoutMs:1000});
 provider.search=async()=>{calls++;controller.abort(reason);throw reason;};
 await assert.rejects(()=>provider.searchWithFallback('q',controller.signal),/cancel/);assert.equal(calls,1);
});
test('ordinary provider outage still allows fallback',async()=>{
 let calls=0;const provider=new w.ZhipuWebSearch({apiKey:'mock',baseUrl:'https://unused.invalid',timeoutMs:1000});
 provider.search=async()=>{if(++calls===1)throw new Error('temporary');return [page];};
 assert.equal((await provider.searchWithFallback('q')).length,1);assert.equal(calls,2);
});
test('factual repair cannot silently target the same-index limitation',()=>{
 assert.equal(parse([{...claim(),repairTargetOriginalIndex:0,repairTargetKind:'limitation'}],evidence([card()]),[],[point()],false).ok,false);
});
test('initial answer rejects repair kind metadata even without a target index',()=>{
 assert.equal(parse([{...claim(),repairTargetKind:'claim'}]).ok,false);
});
test('ordinary factual repair may explicitly identify its claim target',()=>{
 assert.equal(parse([{...claim(),repairTargetOriginalIndex:0,repairTargetKind:'claim'}],evidence([card()]),[],[point()],false).ok,true);
});
