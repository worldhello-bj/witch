import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadSnapshot } from './support/load-snapshot.mjs';
const { GlmBrain, parseResearchNarrative, parseStructuredResearchAnswer } = await loadSnapshot('glm');
const raw = paragraphs => JSON.stringify({ paragraphs });
const points = [
  { id: 1, requestedPointIds: [1], kind: '已核验事实或解释', text: '阿科米娅在开战前提供临时等级。' },
  { id: 2, requestedPointIds: [1], kind: '已核验事实或解释', text: '司空震在觉醒时获得全部效果。' },
  { id: 3, requestedPointIds: [1], kind: '已核验的信息缺口', text: '本轮材料未确认正式服版本与两种描述的关系。' },
];
const sources = [1,2,3].map(id => ({sourceId:id,evidenceGroupId:id,title:`来源${id}`,link:`https://example.org/${id}`,sourceKind:'media'}));
const card = (ids, sourceIds) => ({point:'问项',requestedPointIds:ids,finding:'索引',evidenceScope:'quoted-content',status:'supported',quotes:sourceIds.map(sourceId=>({sourceId,quote:`来源${sourceId}对这个问项的完整逐字引文。`}))});
const evidence = cards => ({cards,gaps:[],sourceDisclosures:[],reviewerNotes:[],independenceAssessments:[]});
const questions = independent => [1,2].map(id=>({id,text:`问题${id}`,independentSupportRequired: independent && id===1}));
const answer = (refs, ids=[1,2]) => JSON.stringify({claims:[{text:'回答各侧。',requestedPointIds:ids,evidenceRefs:refs,group:1,sourceAttribution:'none'}],limitations:[]});
const ref = (cardId,quoteId=0) => ({cardId,quoteId});

test('expression selects already-audited natural sentences',()=>{
  const actual=parseResearchNarrative(raw([{claimRefs:[1,2,3]}]),points);
  assert.equal(actual?.paragraphs[0].text, points.map(p=>p.text).join(' '));
});
for (const [name,text] of [
 ['Sunset role/strength embellishment','阿科米娅是唯一核心，当前关注度和压制力都很突出。'],
 ['lost triggering condition','司空震每次都获得全部效果。'],
 ['absence promoted to negative fact','正式服根本不存在这个玩法。'],
 ['Marco invented other-side identity','上阵英雄马可波罗是编进阵容里真正打仗的棋子。'],
 ['Nezha contradictory occurrence','实际上映日期仍然无法确认。'],
]) test(`rejects ${name} even with every valid citation ID`,()=>{
  assert.equal(parseResearchNarrative(raw([{text,claimRefs:[1,2,3]}]),points),undefined);
});
test('legacy text is accepted only if identical to selected approved sentences',()=>{
  const text=points.map(p=>p.text).join(' ');
  assert.equal(parseResearchNarrative(raw([{text,claimRefs:[1,2,3]}]),points)?.paragraphs[0].text,text);
});
test('coverage requires a fact and all limitations; duplicate and unknown IDs fail closed',()=>{
  for(const paragraphs of [[{claimRefs:[1]}],[{claimRefs:[3]}],[{claimRefs:[1,3,3]}],[{claimRefs:[1,3,99]}]])
    assert.equal(parseResearchNarrative(raw(paragraphs),points),undefined);
  assert.ok(parseResearchNarrative(raw([{claimRefs:[1,3]}]),points));
});
test('cannot borrow a card-wide second question with only its first quote',()=>{
  assert.equal(parseStructuredResearchAnswer(answer([ref(1)]),evidence([card([1,2],[1,2])]),sources,questions(false)).ok,false);
});
test('multi-question claim can cite a separate atomic card for each question',()=>{
  assert.equal(parseStructuredResearchAnswer(answer([ref(1),ref(2)]),evidence([card([1],[1]),card([2],[2])]),sources,questions(false)).ok,true);
});
test('independence must be supported by quotes for the same question',()=>{
  const e=evidence([card([1],[1]),card([2],[2])]);
  e.independenceAssessments=[{requestedPointId:1,sourceIds:[1,2],status:'independent',rationale:'模型声称独立'}];
  assert.equal(parseStructuredResearchAnswer(answer([ref(1),ref(2)]),e,sources,questions(true)).ok,false);
});
test('actual per-question independent quotes still pass',()=>{
  const e=evidence([card([1],[1,3]),card([2],[2])]);
  e.independenceAssessments=[{requestedPointId:1,sourceIds:[1,3],status:'independent',rationale:'独立记录'}];
  assert.equal(parseStructuredResearchAnswer(answer([ref(1),ref(1,1),ref(2)]),e,sources,questions(true)).ok,true);
});
test('expression cancellation propagates instead of returning an apparently completed answer',async()=>{
  const brain=new GlmBrain({apiKey:'mock',baseUrl:'https://unused.invalid',model:'mock',reasoningEffort:'low',maxTokens:1000,timeoutMs:1000},{instructions:'简洁'});
  const controller=new AbortController(); const reason=new Error('owner stopped');
  brain.complete=async()=>{controller.abort(reason);throw reason;};
  await assert.rejects(()=>brain.expressResearchAnswer({text:'问题',attachments:[],signal:controller.signal},{claims:[{text:points[0].text,requestedPointIds:[1],sourceIds:[1],evidenceRefs:[ref(1)],sourceAttribution:'none',group:1}],limitations:[]},evidence([card([1],[1])]),sources),/owner stopped/);
});
test('citations remain next to the exact approved sentence, not laundered over an entire paragraph',async()=>{
  const brain=new GlmBrain({apiKey:'mock',baseUrl:'https://unused.invalid',model:'mock',reasoningEffort:'low',maxTokens:1000,timeoutMs:1000},{instructions:'简洁'});
  brain.complete=async()=>({content:raw([{text:claims.map(c=>c.text).join(' '),claimRefs:[1,2]}])});
  const claims=[1,2].map(id=>({text:`已经审核的句子${id}。`,requestedPointIds:[id],sourceIds:[id],evidenceRefs:[ref(id)],sourceAttribution:'none',group:1}));
  const text=await brain.expressResearchAnswer({text:'问题',attachments:[]},{claims,limitations:[]},evidence([card([1],[1]),card([2],[2])]),sources);
  assert.match(text,/已经审核的句子1。\s*\[媒体平台来源1\]\(https:\/\/example\.org\/1\)\s+已经审核的句子2。\s*\[媒体平台来源2\]/);
});
