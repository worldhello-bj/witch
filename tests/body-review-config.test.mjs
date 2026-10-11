import assert from 'node:assert/strict';
import {test} from 'node:test';
import {loadSnapshot} from './support/load-snapshot.mjs';
const {GlmBrain,selectPageEvidenceExcerpt}=await loadSnapshot('glm');
const {loadConfig}=await loadSnapshot('config');
const unique='关键机制：阿科米娅在开战前提供临时等级。';
test('the evidence reviewer receives quotations that exist only in fetched page text',async()=>{
 const body='背景材料。'.repeat(1000)+unique+'其余背景。'.repeat(1000);
 let payload;
 const brain=new GlmBrain({apiKey:'mock',baseUrl:'https://unused.invalid',model:'mock',reasoningEffort:'low',maxTokens:3000,timeoutMs:1000},{instructions:'简洁'});
 brain.complete=async(messages)=>{payload=JSON.parse(messages[1].content);return{content:JSON.stringify({cards:[{point:'阿科米娅关键机制',requestedPointIds:[1],finding:'正文支持',status:'supported',evidenceScope:'quoted-content',quotes:[{sourceId:1,quote:unique}]}],gaps:[{requestedPointIds:[1],sourceIds:[1],text:'版本仍需确认'}],reviewerNotes:[],sourceDisclosures:[],independenceAssessments:[],followupQueries:[]})};};
 const result=await brain.reviewWebEvidence({text:'阿科米娅关键机制',attachments:[]},['阿科米娅关键机制'],[{title:'网页',link:'https://example.org/page',content:'搜索摘要没有具体机制。',verificationContent:body,fullPageFetched:true,pageContentStatus:'truncated'}],[{id:1,text:'阿科米娅关键机制',independentSupportRequired:false}],[]);
 assert.ok(payload.sources[0].pageContentExcerpt.includes(unique));assert.ok(payload.sources[0].pageContentExcerpt.length<=4000);
 assert.equal(payload.sources[0].pageContentExcerptIsPartial,true);
 assert.equal(result.evidence.cards[0].status,'supported');assert.equal(result.evidence.cards[0].quotes[0].quote,unique);
 assert.equal(result.evidence.sourceCoveragePages[0].textIsPartial,true);
 assert.equal(result.evidence.sourceCoveragePages[0].pageContentStatus,'truncated');
});
test('short page evidence stays verbatim and context selection is always bounded',()=>{
 assert.equal(selectPageEvidenceExcerpt(unique,['机制']),unique);
 const body=('正文内容。'.repeat(3000));assert.ok(selectPageEvidenceExcerpt(body,['无匹配']).length<=4000);
});
function configured(changes){
 const previous={...process.env};
 try{
  for(const key of Object.keys(process.env))if(/^(GLM_|BRAIN_|WITCH_|CODEX_|EXA_|BRAVE_|TAVILY_|BAIDU_)/.test(key))delete process.env[key];
  Object.assign(process.env,{BRAIN_PROVIDER:'mock'},changes);return loadConfig();
 }finally{process.env=previous;}
}
test('search requests and total research have independent documented defaults',()=>{
 const config=configured({});assert.equal(config.glmTimeoutMs,180000);assert.equal(config.glmWebSearchTimeoutMs,30000);assert.equal(config.glmWebSearchTurnTimeoutMs,180000);
});
for(const key of ['GLM_WEB_SEARCH_TIMEOUT_MS','GLM_WEB_SEARCH_TURN_TIMEOUT_MS'])for(const bad of ['0','NaN','Infinity','-1','90000000'])test(`${key} rejects invalid budget ${bad}`,()=>assert.throws(()=>configured({[key]:bad}),/must be between/));
test('documented search/turn overrides reach configuration separately',()=>{
 const config=configured({GLM_WEB_SEARCH_TIMEOUT_MS:'15000',GLM_WEB_SEARCH_TURN_TIMEOUT_MS:'90000'});
 assert.equal(config.glmWebSearchTimeoutMs,15000);assert.equal(config.glmWebSearchTurnTimeoutMs,90000);
});
