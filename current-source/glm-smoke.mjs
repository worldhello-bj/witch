import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { assignEvidenceGroups, bindSearchResultsToQuery, claimMeetsIndependentEvidenceRequirement, classifyWebSearchSourceKind, formatEvidenceForAnswer, formatEvidenceGapsForAnswer, GlmBrain, maxEvidenceFollowupQueries, maxEvidenceSources, parseResearchNarrative, parseStructuredResearchAnswer, prepareSearchCandidate, selectEvidenceSources } from "../dist/brain/glm.js";

const narrative = (paragraphs) => JSON.stringify({ paragraphs });
const expressionPoints = [
  { id: 1, requestedPointIds: [1], kind: "已核验事实或解释", text: "已审核的核心事实。" },
  { id: 2, requestedPointIds: [1], kind: "已核验事实或解释", text: "同一问项的次要事实。" },
  { id: 3, requestedPointIds: [2], kind: "已核验的信息缺口", text: "本轮未核实第二问。" },
  { id: 4, requestedPointIds: [1], kind: "已核验事实或解释", text: "另一条已审核事实。" },
];
const completeNarrative = parseResearchNarrative(narrative([{ claimRefs: [1, 2, 3, 4] }]), expressionPoints);
assert.equal(completeNarrative.paragraphs[0].text, expressionPoints.map(point => point.text).join(" "),
  "the last stage assembles exact audited natural sentences, not an unaudited paraphrase");
assert.ok(parseResearchNarrative(narrative([{ claimRefs: [1, 3] }]), expressionPoints),
  "secondary facts may be omitted when facts, requested points, and every gap remain covered");
assert.equal(parseResearchNarrative(narrative([{ claimRefs: [1] }]), expressionPoints), undefined,
  "omitting an evidence gap fails closed");
assert.equal(parseResearchNarrative(narrative([{ claimRefs: [2] }]), [
  { id: 1, requestedPointIds: [1], kind: "已核验事实或解释", text: "核实事实。" },
  { id: 2, requestedPointIds: [1], kind: "已核验的信息缺口", text: "具体限制。" },
]), undefined, "a limitation cannot replace an available factual answer");
assert.equal(parseResearchNarrative(narrative([{ claimRefs: [1, 3] }]), [
  { ...expressionPoints[0], text: "a".repeat(401) }, expressionPoints[2],
]), undefined, "a selected paragraph above 400 characters uses the audited fallback");
assert.equal(parseResearchNarrative(narrative([{ claimRefs: [1] }, { claimRefs: [3] }]), [
  { ...expressionPoints[0], text: "a".repeat(350) }, { ...expressionPoints[2], text: "b".repeat(351) },
]), undefined, "a selected narrative above 700 characters uses the audited fallback");
const mergedNarrative = parseResearchNarrative(narrative([
  { claimRefs: [1] }, { claimRefs: [2] }, { claimRefs: [4] }, { claimRefs: [3] },
]), expressionPoints);
assert.equal(mergedNarrative.paragraphs.length, 3);
assert.deepEqual(mergedNarrative.paragraphs.flatMap(paragraph => paragraph.claimRefs), [1, 2, 4, 3],
  "paragraph consolidation preserves each approved sentence and its ID");
// Minimal fixture derived from the saved Sunset failure description. The raw
// runtime report was not included in this handoff, so this is not a live replay.
const sunsetSamplePoints = [
  { id: 1, requestedPointIds: [1], kind: "已核验事实或解释", text: "阿科米娅提供临时等级。" },
  { id: 2, requestedPointIds: [2], kind: "已核验事实或解释", text: "司空震在觉醒时获得全部效果。" },
  { id: 3, requestedPointIds: [1, 2], kind: "已核验的信息缺口", text: "本轮无法确认正式服版本及两种描述的关系。" },
];
for (const text of [
  "阿科米娅是唯一核心，关注度和压制力都很突出。",
  "司空震无需觉醒就能获得全部效果。",
  "正式服根本没有这个玩法。",
]) assert.equal(parseResearchNarrative(narrative([{ text, claimRefs: [1, 2, 3] }]), sunsetSamplePoints), undefined,
  "all valid reference IDs do not authorize role swaps, condition loss, or unsupported negative facts");
assert.ok(parseResearchNarrative(narrative([{ claimRefs: [1, 2, 3] }]), sunsetSamplePoints),
  "the exact approved sentences and limitations remain deliverable");

const pointBindingEvidence = {
  cards: [{ point: "问项二", requestedPointIds: [2], finding: "事实卡", evidenceScope: "quoted-content", status: "supported",
    quotes: [{ sourceId: 1, quote: "与问项二有关的逐字引文。" }] }],
  gaps: [], sourceDisclosures: [], independenceAssessments: [], reviewerNotes: [],
};
const pointBindingSources = [{ sourceId: 1, evidenceGroupId: 1, title: "材料", link: "https://example.org/source", sourceKind: "media" }];
const pointBindingAnswer = (pointId) => JSON.stringify({ claims: [{
  text: "针对问项一的结论。", requestedPointIds: [pointId], evidenceRefs: [{ cardId: 1, quoteId: 0 }], group: 1, sourceAttribution: "none",
}], limitations: [] });
assert.equal(parseStructuredResearchAnswer(pointBindingAnswer(1), pointBindingEvidence, pointBindingSources,
  [{ id: 1, text: "问项一", independentSupportRequired: false }]).ok, false,
  "a syntactically valid quote cannot support a claim attached to an unrelated requested point");
assert.equal(parseStructuredResearchAnswer(pointBindingAnswer(2), pointBindingEvidence, pointBindingSources,
  [{ id: 2, text: "问项二", independentSupportRequired: false }]).ok, true,
  "a quote can support a claim when its evidence card is bound to the same requested point");
const savedFilmPoints = [
  { id: 1, text: "哪吒之魔童闹海中国内地实际公映日期", independentSupportRequired: false },
  { id: 2, text: "哪吒之魔童闹海导演", independentSupportRequired: false },
];
const savedFilmDirectorOnlyEvidence = {
  cards: [{ point: "导演", requestedPointIds: [2], finding: "导演为饺子", evidenceScope: "quoted-content", status: "supported",
    quotes: [{ sourceId: 1, quote: "《哪吒之魔童闹海》由饺子编剧并导演。" }] }],
  gaps: [], sourceDisclosures: [], independenceAssessments: [], reviewerNotes: [],
};
assert.equal(parseStructuredResearchAnswer(JSON.stringify({ claims: [{
  text: "上映前媒体曾报道影片定档大年初一。", requestedPointIds: [1], evidenceRefs: [{ cardId: 1, quoteId: 0 }], group: 1,
  sourceAttribution: "none",
}], limitations: [] }), savedFilmDirectorOnlyEvidence, pointBindingSources, savedFilmPoints).ok, false,
  "the saved Nezha report's director quote cannot be attached to the release-date point");
const savedFilmReleaseEvidence = {
  ...savedFilmDirectorOnlyEvidence,
  cards: [{ point: "实际公映日期", requestedPointIds: [1], finding: "事后媒体转述公告确认公映", evidenceScope: "quoted-content", status: "supported",
    quotes: [{ sourceId: 1, quote: "光线传媒公告称影片已于2025年1月29日起在中国大陆地区公映。" }] }],
};
assert.equal(parseStructuredResearchAnswer(JSON.stringify({ claims: [{
  text: "媒体转述公告确认影片自1月29日起公映。", requestedPointIds: [1], evidenceRefs: [{ cardId: 1, quoteId: 0 }], group: 1,
  sourceAttribution: "none",
}], limitations: [{
  text: "本轮没有直接取得公告原文。", requestedPointIds: [1], cardIds: [2], group: 2,
}] }), {
  ...savedFilmReleaseEvidence,
  cards: [...savedFilmReleaseEvidence.cards, { point: "公告原文", requestedPointIds: [1], finding: "未直接取得公告原文", evidenceScope: "retrieval-limit", status: "insufficient", quotes: [] }],
}, pointBindingSources, [savedFilmPoints[0]]).ok, true,
  "a source-bound actual release date may be answered while the missing first-party page remains a separate limitation");
const twoSidePoints = [
  { id: 1, text: "棋手马可波罗的身份与机制", independentSupportRequired: false },
  { id: 2, text: "上阵英雄马可波罗是否存在及其机制", independentSupportRequired: false },
];
const chessplayerOnlyEvidence = {
  cards: [{ point: "棋手马可波罗", requestedPointIds: [1], finding: "棋手材料", evidenceScope: "quoted-content", status: "supported",
    quotes: [{ sourceId: 1, quote: "这段原文只描述棋手马可波罗的机制。" }] }],
  gaps: [], sourceDisclosures: [], independenceAssessments: [], reviewerNotes: [],
};
assert.equal(parseStructuredResearchAnswer(JSON.stringify({ claims: [{
  text: "棋手马可有此机制，上阵英雄马可也能上阵。", requestedPointIds: [1, 2], evidenceRefs: [{ cardId: 1, quoteId: 0 }], group: 1, sourceAttribution: "none",
}], limitations: [] }), chessplayerOnlyEvidence, pointBindingSources, twoSidePoints).ok, false,
  "one side's quote cannot be reused to cover both sides of a split entity-disambiguation question");
const chessplayerAndHeroEvidence = {
  ...chessplayerOnlyEvidence,
  cards: [
    chessplayerOnlyEvidence.cards[0],
    { point: "上阵英雄马可波罗", requestedPointIds: [2], finding: "独立的上阵英雄材料", evidenceScope: "quoted-content", status: "supported",
      quotes: [{ sourceId: 1, quote: "这段原文直接说明上阵英雄马可波罗。" }] },
  ],
};
assert.equal(parseStructuredResearchAnswer(JSON.stringify({ claims: [{
  text: "棋手和上阵英雄两侧各有直接材料。", requestedPointIds: [1, 2], evidenceRefs: [{ cardId: 1, quoteId: 0 }, { cardId: 2, quoteId: 0 }], group: 1, sourceAttribution: "none",
}], limitations: [] }), chessplayerAndHeroEvidence, pointBindingSources, twoSidePoints).ok, true,
  "a combined claim is allowed only when its citations cover every separately requested side");
const chessplayerGapEvidence = {
  cards: [{ point: "上阵英雄马可波罗", requestedPointIds: [2], finding: "本轮未核实", evidenceScope: "retrieval-limit", status: "insufficient", quotes: [] }],
  gaps: [], sourceDisclosures: [], independenceAssessments: [], reviewerNotes: [],
};
const sideLimitation = (pointId) => JSON.stringify({ claims: [], limitations: [{
  text: "上阵英雄马可波罗这一侧本轮没有直接证据。", requestedPointIds: [pointId], cardIds: [1], group: 1,
}] });
assert.equal(parseStructuredResearchAnswer(sideLimitation(1), chessplayerGapEvidence, [], [twoSidePoints[0]]).ok, false,
  "an insufficient card for one entity side cannot be used to describe a different side");
assert.equal(parseStructuredResearchAnswer(sideLimitation(2), chessplayerGapEvidence, [], [twoSidePoints[1]]).ok, true,
  "a missing-side limitation can pass when it is bound to that exact side's gap card");

assert.equal(claimMeetsIndependentEvidenceRequirement([1], [1, 2],
  [{ id: 1, independentSupportRequired: true }],
  [{ sourceId: 1, evidenceGroupId: 7 }, { sourceId: 2, evidenceGroupId: 7 }],
  [{ requestedPointId: 1, sourceIds: [1, 2], status: "independent" }]), false,
  "the program rejects an independence label when both URLs share a duplicate evidence group");
assert.equal(claimMeetsIndependentEvidenceRequirement([1], [1, 2],
  [{ id: 1, independentSupportRequired: true }],
  [{ sourceId: 1, evidenceGroupId: 7 }, { sourceId: 2, evidenceGroupId: 8 }],
  [{ requestedPointId: 1, sourceIds: [1, 2], status: "independent" }]), true,
  "an explicitly corroborated point requires distinct evidence groups and a source-relationship review");
assert.equal(claimMeetsIndependentEvidenceRequirement([1], [1, 2],
  [{ id: 1, independentSupportRequired: true }],
  [{ sourceId: 1, evidenceGroupId: 7 }, { sourceId: 2, evidenceGroupId: 8 }],
  [{ requestedPointId: 1, sourceIds: [1, 2], status: "uncertain" }]), false,
  "different URLs do not satisfy independent support when source relationship is uncertain");
assert.equal(claimMeetsIndependentEvidenceRequirement([1], [1],
  [{ id: 1, independentSupportRequired: false }],
  [{ sourceId: 1, evidenceGroupId: 7 }]), true,
  "ordinary single-source factual points retain their existing evidence rule");

assert.equal(classifyWebSearchSourceKind("https://wxq.qq.com/article"), "publisher");
const multiSourceEvidence = {
  cards: [{ point: "核心机制", finding: "多来源分别支持机制描述。", evidenceScope: "quoted-content", status: "supported",
    quotes: [1, 2, 3, 4, 5].map((sourceId) => ({ sourceId, quote: `来源${sourceId}的逐字原文证据。` })) }],
  gaps: [], sourceDisclosures: [],
};
const multiSourceMetadata = [
  { sourceId: 1, evidenceGroupId: 1 }, { sourceId: 2, evidenceGroupId: 1 },
  { sourceId: 3, evidenceGroupId: 2 }, { sourceId: 4, evidenceGroupId: 3 },
  { sourceId: 5, evidenceGroupId: 4 },
];
assert.deepEqual(formatEvidenceGapsForAnswer({ gaps: [
  { requestedPointIds: [1], sourceIds: [2, 99], text: "来源未覆盖的子项" },
] }, multiSourceMetadata), [
  { requestedPointIds: [1], sourceIds: [2], text: "来源未覆盖的子项" },
], "evidence gaps retain only valid, explicitly bound source IDs");
assert.deepEqual(
  formatEvidenceForAnswer(multiSourceEvidence, multiSourceMetadata).cards[0].quotes.map((quote) => quote.quoteId),
  [0, 2, 3],
  "answer context keeps at most three quotes per card while preferring independent evidence groups and preserves original quote IDs",
);
assert.deepEqual(
  formatEvidenceForAnswer(multiSourceEvidence, multiSourceMetadata, [{ cardId: 1, quoteId: 4 }]).cards[0].quotes.map((quote) => quote.quoteId),
  [0, 2, 4],
  "answer audit context always includes the exact quotes referenced by accepted claims",
);
assert.equal(classifyWebSearchSourceKind("https://static.cninfo.com.cn/finalpage/2025-02-05/example.pdf"), "disclosure",
  "a filing hosted on the exact CNINFO document host is distinguished from issuer-owned publisher domains");
assert.equal(classifyWebSearchSourceKind("https://news.qq.com/rain/a/example"), "media",
  "hosting classification remains media even when metadata supplies a possible account author");
assert.equal(classifyWebSearchSourceKind("https://www.cdht.gov.cn/cdht/c139818/example.html"), "government",
  "a municipal government article is not mislabeled as an unknown host or the film publisher");
assert.equal(classifyWebSearchSourceKind("https://ent.people.com.cn/n1/example.html"), "media",
  "a People's Daily hosted report is classified as media rather than an unknown host");
assert.equal(classifyWebSearchSourceKind("https://www.guancha.cn/politics/example.html"), "media",
  "a recognized news site in the saved acceptance set is identified as media");
assert.equal(classifyWebSearchSourceKind("https://club.honor.com/cn/thread/example"), "community",
  "a community-hosted forum post is not mislabeled as an unknown domain or game-publisher source");
assert.equal(classifyWebSearchSourceKind("https://www.18183.com/guide"), "community");
assert.equal(classifyWebSearchSourceKind("https://wxq.qq.com.evil.example/"), "unverified");
assert.equal(classifyWebSearchSourceKind("https://static.cninfo.com.cn.evil.example/file.pdf"), "unverified");
assert.equal(classifyWebSearchSourceKind("javascript:alert(1)"), "unverified");
const duplicateBody = "这个来源正文包含用于确认重复内容的同一段具体原文。".repeat(20);
const duplicateGroups = assignEvidenceGroups([
  { title: "转载一", link: "https://news.example/a?utm_source=exa", content: duplicateBody },
  { title: "转载二", link: "https://mirror.example/copy", content: duplicateBody },
  { title: "不同正文", link: "https://other.example/page", content: `${duplicateBody}新增了不同结论和条件。` },
]);
assert.equal(duplicateGroups.get(1), duplicateGroups.get(2),
  "different URLs with identical substantial bodies belong to one evidence group");
assert.notEqual(duplicateGroups.get(1), duplicateGroups.get(3),
  "different body text remains a distinct evidence group");
const linkedGroups = assignEvidenceGroups([
  { title: "A", link: "https://mirror.example/a", content: duplicateBody },
  { title: "B", link: "https://mirror.example/b", content: "不同内容。" },
  { title: "B 的重复页但正文为 A", link: "https://mirror.example/b", content: duplicateBody },
]);
assert.equal(linkedGroups.get(1), linkedGroups.get(2));
assert.equal(linkedGroups.get(2), linkedGroups.get(3),
  "overlapping URL and body fingerprints merge transitively into one evidence group");
const balancedSources = ["query-a", "query-b", "query-c"].flatMap((query, queryIndex) =>
  Array.from({ length: 10 }, (_unused, resultIndex) => ({
    title: `${query}-${resultIndex}`,
    link: `https://example.org/${queryIndex}-${resultIndex}`,
    content: `passage ${query}-${resultIndex}`,
    searchExcerpts: [{ query, text: `passage ${query}-${resultIndex}` }],
  })));
const selectedSources = selectEvidenceSources(balancedSources, ["query-a", "query-b", "query-c"]);
assert.equal(selectedSources.length, 12,
  "evidence review caps the model context at twelve sources");
assert.deepEqual(selectedSources.slice(0, 6).map((source) => source.searchExcerpts?.[0]?.query),
  ["query-a", "query-b", "query-c", "query-a", "query-b", "query-c"],
  "source candidates are selected round-robin across query facets, not two from each followed by one query's tail");
assert.deepEqual(selectedSources.map((source) => source.searchExcerpts?.[0]?.query),
  ["query-a", "query-b", "query-c", "query-a", "query-b", "query-c", "query-a", "query-b", "query-c", "query-a", "query-b", "query-c"],
  "a 12-source evidence budget is distributed evenly across three query facets while preserving each provider's ranking");
const fusedRankSources = [
  { title: "Exa 单独排首位", link: "https://example.org/exa-first", content: "A",
    searchExcerpts: [{ query: "same query", text: "A", provider: "exa" }],
    searchRanks: [{ query: "same query", provider: "exa", rank: 1 }] },
  { title: "多引擎排名一致", link: "https://example.org/consensus", content: "B",
    searchExcerpts: [{ query: "same query", text: "B", provider: "exa" }, { query: "same query", text: "B", provider: "tavily" }],
    searchRanks: [{ query: "same query", provider: "exa", rank: 2 }, { query: "same query", provider: "tavily", rank: 1 }] },
  { title: "百度单独排首位", link: "https://example.org/baidu-first", content: "C",
    searchExcerpts: [{ query: "same query", text: "C", provider: "baidu" }],
    searchRanks: [{ query: "same query", provider: "baidu", rank: 1 }] },
];
assert.deepEqual(selectEvidenceSources(fusedRankSources, ["same query"], 3).map((source) => source.title),
  ["多引擎排名一致", "Exa 单独排首位", "百度单独排首位"],
  "reciprocal-rank fusion promotes cross-index relevance agreement without comparing provider score scales");
assert.equal(maxEvidenceSources(fusedRankSources), 9,
  "three distinct indexes use a smaller evidence packet instead of multiplying model context");
assert.equal(maxEvidenceFollowupQueries(fusedRankSources), 1,
  "three indexes allow only one targeted follow-up because each query fans out to every provider");
assert.equal(maxEvidenceSources([fusedRankSources[0], { ...fusedRankSources[0], searchRanks: [{ query: "same query", provider: "exa", rank: 1 }] }]), 12,
  "a single-index route retains the full evidence source budget");
const fusedGroups = assignEvidenceGroups(fusedRankSources);
assert.notEqual(fusedGroups.get(1), fusedGroups.get(2),
  "rank agreement never merges distinct sources or treats retrieval relevance as evidentiary independence");
const preparedRankCandidate = prepareSearchCandidate({
  title: "ranked result", link: "https://example.org/ranked", content: "evidence",
  searchProviders: ["exa", "tavily"],
  searchRanks: [
    { query: "question", provider: "exa", rank: 2 },
    { query: "question", provider: "tavily", rank: 1 },
  ],
});
assert.deepEqual(preparedRankCandidate?.searchRanks, [
  { query: "question", provider: "exa", rank: 2 },
  { query: "question", provider: "tavily", rank: 1 },
], "the production candidate-normalization boundary preserves validated provider ranks for RRF");
assert.equal(prepareSearchCandidate({ title: "unsafe", link: "javascript:alert(1)", content: "x" }), undefined,
  "rank metadata cannot cause an unsafe provider URL to enter the evidence shortlist");
const crossQueryDuplicate = selectEvidenceSources([
  { title: "共享页面", link: "https://example.org/shared", content: "same page",
    searchExcerpts: [{ query: "query-a", text: "same page" }, { query: "query-b", text: "same page" }] },
  { title: "A next", link: "https://example.org/a-next", content: "A",
    searchExcerpts: [{ query: "query-a", text: "A" }] },
  { title: "B next", link: "https://example.org/b-next", content: "B",
    searchExcerpts: [{ query: "query-b", text: "B" }] },
  { title: "C first", link: "https://example.org/c-first", content: "C",
    searchExcerpts: [{ query: "query-c", text: "C" }] },
], ["query-a", "query-b", "query-c"]);
assert.deepEqual(crossQueryDuplicate.map((source) => source.link), [
  "https://example.org/shared", "https://example.org/b-next", "https://example.org/c-first", "https://example.org/a-next",
], "a shared URL occupies one slot only; other query facets get their turn before the list is filled");
const perQueryBound = bindSearchResultsToQuery(Array.from({ length: 20 }, (_unused, index) => ({
  title: `result-${index + 1}`, link: `https://example.org/result-${index + 1}`, content: `excerpt-${index + 1}`,
})), "targeted query");
assert.equal(perQueryBound.length, 20, "a three-index query contributes at most ten Exa plus five Brave plus five Tavily candidates");
assert.equal(perQueryBound[19]?.searchExcerpts?.[0]?.query, "targeted query",
  "each retained result keeps the exact query provenance used for later balancing");
const rankedQueryBinding = bindSearchResultsToQuery([
  { title: "first", link: "https://example.org/first", content: "one", searchProviders: ["tavily"] },
  { title: "second", link: "https://example.org/second", content: "two", searchProviders: ["tavily"] },
], "ranked query");
assert.deepEqual(rankedQueryBinding.map((item) => item.searchRanks?.[0]), [
  { query: "ranked query", provider: "tavily", rank: 1 },
  { query: "ranked query", provider: "tavily", rank: 2 },
], "single-provider search lists also retain stable ranks so every route can use the same selection logic");
const mergedProviderLineage = bindSearchResultsToQuery([{
  title: "same page", link: "https://example.org/shared", content: "Exa excerpt",
  searchProviders: ["exa", "brave"],
  searchExcerpts: [
    { query: "", text: "Exa excerpt", provider: "exa" },
    { query: "", text: "Brave excerpt", provider: "brave" },
  ],
}], "focused query");
assert.deepEqual(mergedProviderLineage[0].searchExcerpts.map((item) => item.provider), ["exa", "brave"],
  "query binding preserves independent search-provider excerpts instead of overwriting provenance");

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "witch-glm-smoke-"));
const imagePath = path.join(tempDir, "tiny.png");
await fs.writeFile(imagePath, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB", "base64"));

let requestBody;
let authorization;
let semanticSearchMode = false;
let semanticSelfDescriptionMode = false;
let semanticFollowupMode = false;
let semanticDuplicateFollowupMode = false;
let semanticFollowupReviewPasses = 0;
let semanticMalformedFollowupReviewOnce = false;
let semanticMalformedFollowupReviewAlways = false;
let semanticSearchCalls = 0;
let semanticSearchModelCalls = 0;
let semanticSearchReviewCalls = 0;
let semanticReviewRequest;
let semanticSynthesisRequest;
let semanticRepairRequest;
let semanticAnswerAuditRequest;
let semanticRelevanceAuditRequest;
let semanticScopeReviewRequest;
let semanticTargetedRepairRequest;
let semanticExpressionRequest;
let semanticNarrativeAuditRequest;
let semanticRejectAnswerFirst = false;
let semanticAnswerRejected = false;
let semanticCoverageMode = false;
let semanticCoveragePageNoteMode = false;
let semanticScopeSchemaOmitOnce = false;
let semanticMissingEvidenceRefsMode = false;
let semanticCoverageRejected = false;
let semanticScopeRelevanceMode = false;
let semanticScopeRelevanceRejected = false;
let semanticLimitationsMode = false;
let semanticInvalidLimitationMode = false;
let semanticRepairPruneMode = false;
let semanticRepairPruneAuditStage = 0;
let semanticTargetedRepairMode = false;
let semanticTargetedRelevanceCalls = 0;
let semanticTargetedAnswerAuditCalls = 0;
let semanticMalformedAuditOnce = false;
let semanticMalformedRelevanceOnce = false;
let semanticSynthesisCalls = 0;
let semanticAnswerAuditCalls = 0;
let semanticNarrativeAuditCalls = 0;
let semanticRejectNarrativeAudits = false;
let semanticMalformedExpressionOnce = false;
let semanticOverlongExpressionOnce = false;
let semanticTruncatedEvidenceOnce = false;
const semanticResearchPlans = [];
const server = http.createServer(async (request, response) => {
  authorization = request.headers.authorization;
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  requestBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (semanticSearchMode) semanticSearchModelCalls += 1;
  const isSearchAnswer = semanticSearchMode && requestBody.messages.some(message => message.role === "tool");
  const isResearchPlanner = semanticSearchMode && requestBody.response_format?.type === "json_object"
    && requestBody.messages[0]?.content?.includes("联网需求判断与查询规划器");
  const isQuestionScopeReview = semanticSearchMode && requestBody.response_format?.type === "json_object"
    && requestBody.messages[0]?.content?.includes("独立的问题范围审查器");
  if (isResearchPlanner) semanticResearchPlans.push(JSON.parse(requestBody.messages[1].content));
  const isSearchReview = semanticSearchMode && requestBody.response_format?.type === "json_object"
    && typeof requestBody.messages[0]?.content === "string" && requestBody.messages[0].content.includes("联网证据审查器");
  const isAnswerAudit = semanticSearchMode && requestBody.response_format?.type === "json_object"
    && typeof requestBody.messages[0]?.content === "string" && requestBody.messages[0].content.includes("联网答案验收器");
  const isRelevanceAudit = semanticSearchMode && requestBody.response_format?.type === "json_object"
    && typeof requestBody.messages[0]?.content === "string" && requestBody.messages[0].content.includes("答案相关性审查器");
  const isResearchExpression = semanticSearchMode && requestBody.response_format?.type === "json_object"
    && typeof requestBody.messages[0]?.content === "string" && requestBody.messages[0].content.includes("自然表达层");
  const isNarrativeAudit = semanticSearchMode && requestBody.response_format?.type === "json_object"
    && typeof requestBody.messages[0]?.content === "string" && requestBody.messages[0].content.includes("独立自然表达验收器");
  const isSearchSynthesis = semanticSearchMode && requestBody.response_format?.type === "json_object"
    && typeof requestBody.messages[0]?.content === "string" && requestBody.messages[0].content.includes("把已审核证据整理成自然");
  if (isSearchReview) semanticReviewRequest = requestBody;
  if (isSearchReview) semanticSearchReviewCalls += 1;
  if (isAnswerAudit) semanticAnswerAuditRequest = requestBody;
  if (isQuestionScopeReview) semanticScopeReviewRequest = requestBody;
  if (isRelevanceAudit) semanticRelevanceAuditRequest = requestBody;
  if (isAnswerAudit) semanticAnswerAuditCalls += 1;
  if (isResearchExpression) semanticExpressionRequest = requestBody;
  if (isNarrativeAudit) semanticNarrativeAuditRequest = requestBody;
  const forceTruncatedEvidence = isSearchReview && semanticTruncatedEvidenceOnce;
  if (forceTruncatedEvidence) semanticTruncatedEvidenceOnce = false;
  if (isSearchSynthesis) {
    semanticSynthesisRequest = requestBody;
    semanticSynthesisCalls += 1;
    if (requestBody.messages.some(message => message.role === "system" && message.content.includes("只重写 repairTargets.rejectedClaims"))) {
      semanticTargetedRepairRequest = requestBody;
    }
    if (requestBody.messages.some(message => message.role === "system" && message.content.includes("前一版未通过结构或证据审查"))) {
      semanticRepairRequest = requestBody;
    }
  }
  const isSearchPlanner = typeof requestBody.messages?.[0]?.content === "string"
    && requestBody.messages[0].content.includes("改写成一条可独立检索的查询词");
  const isVisualPlanner = typeof requestBody.messages?.[0]?.content === "string"
    && requestBody.messages[0].content.includes("图片联网查证规划器");
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ choices: [{ finish_reason: forceTruncatedEvidence ? "length" : "stop", message: isResearchPlanner
      ? { content: JSON.stringify(JSON.parse(requestBody.messages[1].content).currentMessage.includes("我今天有点累")
        ? { needsSearch: false, queries: [], answerPoints: [], responseConstraints: [] }
        : { needsSearch: true, queries: ["王者万象棋 马可养猪流 阵容 棋手 上阵英雄",
          "王者万象棋 马可养猪流 运营阶段 条件", "王者万象棋 马可养猪流 适用版本"],
          answerPoints: ["用户当前问到的核心机制或事实"],
          responseConstraints: ["不要把相似玩法混在一起"] }) }
    : isQuestionScopeReview
    ? { content: semanticScopeSchemaOmitOnce
      ? (semanticScopeSchemaOmitOnce = false, JSON.stringify({ answerPoints: ["用户当前问到的核心机制或事实"], responseConstraints: ["不要把相似玩法混在一起"] }))
      : JSON.stringify({ answerPoints: ["用户当前问到的核心机制或事实"],
        responseConstraints: ["不要把相似玩法混在一起"], independentSupportPointIds: [] }) }
    : isSearchReview
    ? { content: semanticFollowupMode && semanticFollowupReviewPasses === 1
      && (semanticMalformedFollowupReviewAlways || semanticMalformedFollowupReviewOnce)
      ? (semanticMalformedFollowupReviewOnce = false, JSON.stringify({ cards: { malformed: true } }))
      : `审核结果如下：\n${JSON.stringify({ cards: [
      { point: "棋手与上阵英雄的区别", requestedPointIds: [1], finding: "来源将棋手和上阵英雄分别列出；另有一条材料发布日期早于作品正式上线，正文还称其讲的是另一款游戏，不能据此断言为当前作品攻略。", evidenceScope: "quoted-content", status: "supported",
        quotes: [{ sourceId: 1, quote: "该攻略分别列出马可波罗棋手和上阵英雄。" },
          { sourceId: 1, quote: "该攻略分别列出马可波罗棋手和上阵英雄。" },
          { sourceId: 1, quote: "该攻略分别列出马可波罗棋手和上阵英雄。" }] },
      { point: "来源未覆盖的扩展结论", requestedPointIds: [1], finding: "不能从现有正文核实。", evidenceScope: "retrieval-limit", status: "supported",
        quotes: [{ sourceId: 1, quote: "这句原文并不存在，不能当证据。" }] },
      { point: "核心机制", requestedPointIds: [1], finding: "核心机制见另一条摘录。", evidenceScope: "quoted-content", status: "supported",
        quotes: [{ sourceId: 1, quote: semanticScopeRelevanceMode
          ? "核心机制是将棋手与上阵英雄分别列出。"
          : "核心机制见另一条摘录，相关描述可在此核实。" }] },
      { point: "重复转载制造的冲突", requestedPointIds: [1], finding: "两个页面报告不同结果。", evidenceScope: "quoted-content", status: "conflicting",
        quotes: [{ sourceId: 1, quote: "该攻略分别列出马可波罗棋手和上阵英雄。" },
          { sourceId: 2, quote: "该攻略分别列出马可波罗棋手和上阵英雄。" }] },
    ], reviewerNotes: [{ requestedPointIds: [1], sourceIds: semanticCoveragePageNoteMode ? [2] : [1], riskType: "entity",
      note: "该来源正文自称讲的是另一款游戏，能否适用于当前作品尚未核实。" },
      { requestedPointIds: [999], sourceIds: [999], riskType: "identity", note: "这条备注没有绑定到已知来源或问项，必须被丢弃。" }], sourceDisclosures: [
      { sourceId: 1, quote: "2025-07-17发布于北京腾讯游戏官方账号" },
      { sourceId: 1, quote: "这段身份说明不在来源正文中" },
    ],
      gaps: [{ requestedPointIds: [1], sourceIds: [1], text: "真实强度与适用版本未被正文证明" }],
      followupQueries: semanticFollowupMode && semanticFollowupReviewPasses++ === 0
        ? ["腾讯游戏 王者万象棋 官方规则"] : [] })}\n审核结束。` }
    : isRelevanceAudit
      ? { content: semanticMalformedRelevanceOnce
        ? (semanticMalformedRelevanceOnce = false, "not-json")
        : semanticTargetedRepairMode
        ? JSON.stringify(semanticTargetedRelevanceCalls++ === 0
          ? { approved: false, rejectedClaims: [0], rejectedLimitations: [], issues: ["类型主张混入了未询问的上线日期"] }
          : { approved: true, rejectedClaims: [], rejectedLimitations: [], issues: [] })
        : JSON.stringify(semanticScopeRelevanceMode && !semanticScopeRelevanceRejected
        ? (semanticScopeRelevanceRejected = true, { approved: false, rejectedClaims: [0], rejectedLimitations: [], issues: ["发布日期并非用户询问的游戏类型或核心玩法"] })
        : { approved: true, rejectedClaims: [], rejectedLimitations: [], issues: [] }) }
    : isAnswerAudit
      ? { content: semanticMalformedAuditOnce
        ? (semanticMalformedAuditOnce = false, "not-json")
        : semanticRepairPruneMode
        ? (semanticRepairPruneAuditStage++ === 0
          ? JSON.stringify({ approved: false, rejectedClaims: [], rejectedLimitations: [], issues: ["请重写答案措辞"] })
          : semanticRepairPruneAuditStage <= 3
          ? JSON.stringify({ approved: false, rejectedClaims: [0], rejectedLimitations: [], issues: ["第一条主张不受原文支持"] })
          : JSON.stringify({ approved: true, rejectedClaims: [], rejectedLimitations: [], issues: [] }))
        : semanticTargetedRepairMode
        ? JSON.stringify(semanticTargetedAnswerAuditCalls++ === 0
          ? { approved: false, rejectedClaims: [1], rejectedLimitations: [], issues: ["把公告计划写成已经开放"] }
          : { approved: true, rejectedClaims: [], rejectedLimitations: [], issues: [] })
        : semanticInvalidLimitationMode
        ? JSON.stringify({ approved: true, rejectedClaims: [], rejectedLimitations: [], issues: [] })
        : semanticLimitationsMode
        ? JSON.stringify({ approved: true, rejectedClaims: [], rejectedLimitations: [], issues: [] })
        : semanticCoverageMode && !semanticCoverageRejected
        ? (semanticCoverageRejected = true, JSON.stringify({ approved: false, rejectedClaims: [0], rejectedLimitations: [], issues: ["没有直接回答用户明确询问的上映日期"] }))
        : JSON.stringify(semanticRejectAnswerFirst && !semanticAnswerRejected
          ? (semanticAnswerRejected = true, { approved: false, rejectedClaims: [0], rejectedLimitations: [], issues: ["加入了事实卡未支持的推断"] })
          : { approved: true, rejectedClaims: [], rejectedLimitations: [], issues: [] }) }
    : isNarrativeAudit
      ? (semanticNarrativeAuditCalls += 1,
        { content: JSON.stringify(semanticRejectNarrativeAudits
          ? { approved: false, issues: ["自然表达加入了事实卡未支持的行动建议"] }
          : { approved: true, issues: [] }) })
    : isResearchExpression
      ? { content: (() => {
        if (semanticMalformedExpressionOnce) {
          semanticMalformedExpressionOnce = false;
          return "not-json";
        }
        const data = JSON.parse(requestBody.messages.at(-1).content);
        if (semanticOverlongExpressionOnce) {
          semanticOverlongExpressionOnce = false;
          return JSON.stringify({ paragraphs: [{
            text: "过长".repeat(351),
            claimRefs: data.approvedPoints.map(point => point.id),
          }] });
        }
        return JSON.stringify({ paragraphs: [{
          claimRefs: data.approvedPoints.map(point => point.id),
        }] });
      })() }
    : {
    content: isSearchSynthesis
      ? JSON.stringify(semanticMissingEvidenceRefsMode
        ? requestBody.messages.some(message => message.role === "system" && message.content.includes("前一版未通过结构或证据审查"))
          ? { claims: [
            { text: "来源将棋手与上阵英雄分别列出。", requestedPointIds: [1], evidenceRefs: [{ cardId: 1, quoteId: 0 }], group: 1, sourceAttribution: "none" },
          ], limitations: [] }
          : { claims: [
            { text: "页面没有提到马可参与养猪流。", requestedPointIds: [1], evidenceRefs: [], group: 1, sourceAttribution: "none" },
          ], limitations: [] }
        : semanticTargetedRepairMode
        ? (() => {
          const systemText = requestBody.messages.filter(message => message.role === "system").map(message => message.content).join("\n");
          const targeted = systemText.includes("只重写 repairTargets.rejectedClaims");
          const claims = targeted
            ? semanticTargetedRelevanceCalls === 1
              ? [
                { text: "《星痕共鸣》是一款MMORPG。", requestedPointIds: [1], evidenceRefs: [{ cardId: 1, quoteId: 0 }], group: 1, sourceAttribution: "none", repairTargetOriginalIndex: 0 },
                { text: "来源说团本已经开放。", requestedPointIds: [1], evidenceRefs: [{ cardId: 3, quoteId: 0 }], group: 2, sourceAttribution: "none" },
              ]
              : [
                { text: "《星痕共鸣》是MMORPG，由腾讯发行并于2025年7月上线。", requestedPointIds: [1], evidenceRefs: [{ cardId: 1, quoteId: 0 }], group: 1, sourceAttribution: "none", repairTargetOriginalIndex: 0 },
                { text: "来源说团本按公告计划开放。", requestedPointIds: [1], evidenceRefs: [{ cardId: 3, quoteId: 0 }], group: 2, sourceAttribution: "none", repairTargetOriginalIndex: 1 },
              ]
            : [
              { text: "《星痕共鸣》是一款MMORPG，由腾讯发行并于2025年7月上线。", requestedPointIds: [1], evidenceRefs: [{ cardId: 1, quoteId: 0 }], group: 1, sourceAttribution: "none" },
              { text: "来源说团本已经开放。", requestedPointIds: [1], evidenceRefs: [{ cardId: 3, quoteId: 0 }], group: 2, sourceAttribution: "none" },
            ];
          return { claims, limitations: [] };
        })()
        : semanticScopeRelevanceMode
        ? requestBody.messages.some(message => message.role === "system" && message.content.includes("只重写 repairTargets.rejectedClaims"))
          ? { claims: [
            { text: "核心机制是将棋手与上阵英雄分别列出。", requestedPointIds: [1], evidenceRefs: [{ cardId: 3, quoteId: 0 }], group: 1, sourceAttribution: "none", repairTargetOriginalIndex: 0 },
          ], limitations: [] }
          : { claims: [
            { text: "来源将棋手与上阵英雄分别列出；游戏于2025年7月17日上线。", requestedPointIds: [1], evidenceRefs: [{ cardId: 1, quoteId: 0 }], group: 1, sourceAttribution: "none" },
          ], limitations: [] }
        : semanticRepairPruneMode
        ? requestBody.messages.some(message => message.role === "system" && message.content.includes("repairTargetOriginalIndex"))
          ? { claims: [
            { text: "来源将棋手与上阵英雄分别列出。", requestedPointIds: [1], evidenceRefs: [{ cardId: 1, quoteId: 0 }], group: 1, sourceAttribution: "none", repairTargetOriginalIndex: 0 },
          ], limitations: [] }
          : { claims: [
          { text: "这套阵容胜率最高。", requestedPointIds: [1], evidenceRefs: [{ cardId: 1, quoteId: 0 }], group: 1, sourceAttribution: "none" },
          { text: "来源将棋手与上阵英雄分别列出。", requestedPointIds: [1], evidenceRefs: [{ cardId: 1, quoteId: 0 }], group: 1, sourceAttribution: "none" },
        ], limitations: [] }
        : semanticInvalidLimitationMode
        ? { claims: [{ text: "攻略把棋手马可与上阵英雄分开介绍。", requestedPointIds: [1], evidenceRefs: [{ cardId: 1, quoteId: 0 }], group: 1, sourceAttribution: "none" }],
          limitations: [{ text: "强度和版本不能确认。", cardIds: "1", group: 2 }] }
        : semanticLimitationsMode
        ? { claims: [{ text: "攻略把棋手马可与上阵英雄分开介绍。", requestedPointIds: [1], evidenceRefs: [{ cardId: 1, quoteId: 0 }], group: 1, sourceAttribution: "none" }],
          limitations: [{ text: "但强度与禁用条件的适用版本，现有材料没能确认。", requestedPointIds: [1], cardIds: [2], group: 6 }] }
        : { claims: [{ text: semanticCoverageMode
        ? (requestBody.messages.some(message => message.role === "system" && (message.content.includes("前一版未通过结构或证据审查") || message.content.includes("只重写 repairTargets.rejectedClaims")))
          ? "《哪吒之魔童闹海》于2025年1月29日在中国内地上映。"
          : "这部动画有不少相关报道。")
        : semanticRejectAnswerFirst && !semanticAnswerRejected
        ? "这套阵容胜率最高。"
        : "我查到的攻略把棋手和上阵英雄分开写；页面也说明了核心机制。",
        requestedPointIds: [1], evidenceRefs: [{ cardId: 1, quoteId: 0 }, { cardId: 3, quoteId: 0 }], group: 1, sourceAttribution: "none",
        ...(requestBody.messages.some(message => message.role === "system" && message.content.includes("repairTargetOriginalIndex"))
          ? { repairTargetOriginalIndex: 0 } : {}) },
      { text: "官方指定玩法。", requestedPointIds: [1], evidenceRefs: [{ cardId: 1, quoteId: 0 }], group: 1, sourceAttribution: "verified-publisher" },
      { text: "这是来源不支持的玩法。", requestedPointIds: [1], evidenceRefs: [{ cardId: 2, quoteId: 0 }], group: 1, sourceAttribution: "none" },
      ...(semanticSelfDescriptionMode ? [{ text: "该账号自称为官方，但身份未经独立核验。", requestedPointIds: [1], evidenceRefs: [{ cardId: 1, quoteId: 0 }], group: 2, sourceAttribution: "self-description" }] : [])] })
      : isSearchAnswer
      ? "我查到的攻略把棋手和上阵英雄分开写。"
      : requestBody.response_format?.type === "json_object"
      ? isVisualPlanner
        ? '{"query":"王者万象棋 胜利结算 白发角色 识别"}'
        : isSearchPlanner
        ? '{"query":"王者万象棋 白歌 墨世龙尘 祈愿活动"}'
        : '{"action":"chat","reply":"路由回复"}'
      : "测试回复",
  } }] }));
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();

try {
  const brain = new GlmBrain({
    apiKey: "test-key",
    baseUrl: `http://127.0.0.1:${address.port}`,
    model: "glm-5.3-flash",
    reasoningEffort: "high",
    maxTokens: 4096,
    timeoutMs: 10_000,
  }, { id: "witch", version: "test", sourcePath: "test", instructions: "保持简洁。" });
  const result = await brain.reply({
    conversationId: "onebot:private:1",
    text: "看图",
    attachments: [{ kind: "image", mimeType: "image/png", localPath: imagePath }],
  });
  assert.equal(result.text, "测试回复");
  assert.equal(result.provider, "glm");
  assert.equal(authorization, "Bearer test-key");
  assert.equal(requestBody.model, "glm-5.3-flash");
  assert.equal(requestBody.thinking.type, "enabled");
  assert.equal(requestBody.reasoning_effort, "high");
  assert.match(requestBody.messages[0].content[0].text, /当前大脑提供商：智谱 GLM API/);
  assert.match(requestBody.messages[0].content[0].text, /当前模型：glm-5\.3-flash/);
  assert.match(requestBody.messages[0].content[1].image_url.url, /^data:image\/png;base64,/);

  const route = await brain.classifyRouteIntent(
    { conversationId: "onebot:private:2", text: "递归二分怎么写", attachments: [] },
    "只输出一个 JSON 对象。",
  );
  assert.equal(route, '{"action":"chat","reply":"路由回复"}');
  assert.deepEqual(requestBody.response_format, { type: "json_object" });
  assert.deepEqual(requestBody.messages.map((message) => message.role), ["system", "user"]);

  const plannedQuery = await brain.planWebSearchQuery({
    conversationId: "onebot:private:3",
    text: "查一下我刚才说的那个活动",
    attachments: [],
    history: [{
      role: "user",
      source: "qq",
      text: "王者万象棋白歌皮肤祈愿活动",
      timestamp: "2026-09-16T00:00:00.000Z",
    }],
  }, "我刚才说的那个活动");
  assert.equal(plannedQuery, "王者万象棋 白歌 墨世龙尘 祈愿活动");
  assert.deepEqual(requestBody.response_format, { type: "json_object" });
  assert.match(requestBody.messages[0].content, /可独立检索的查询词/);

  const visualQuery = await brain.planImageWebSearchQuery({
    conversationId: "onebot:private:4",
    text: "",
    attachments: [{ kind: "image", mimeType: "image/png", localPath: imagePath }],
    history: [{
      role: "user",
      source: "qq",
      text: "最近在玩王者万象棋",
      timestamp: "2026-09-17T00:00:00.000Z",
    }],
  });
  assert.equal(visualQuery, "王者万象棋 胜利结算 白发角色 识别");
  assert.match(requestBody.messages[0].content, /图片联网查证规划器/);
  assert.match(requestBody.messages[1].content[1].image_url.url, /^data:image\/png;base64,/);

  const searchRequests = [];
  const searchBrain = new GlmBrain({
    apiKey: "test-key", baseUrl: `http://127.0.0.1:${address.port}`, model: "glm-5.3-flash",
      reasoningEffort: "high", maxTokens: 4096, timeoutMs: 10_000,
    webSearch: { async searchWithFallback(query, signal, context) {
      semanticSearchCalls += 1;
      searchRequests.push({ query, signal, context });
      return [{ title: semanticSearchCalls <= 2 ? "腾讯新闻托管的账号文章" : "玩家阵容攻略",
        link: semanticSearchCalls === 3 ? "https://example.org/version"
          : semanticSearchCalls === 4 ? "https://example.org/official"
          : semanticSearchCalls <= 2 ? "https://news.qq.com/rain/a/example" : "https://example.org/guide",
        author: semanticSearchCalls <= 2 ? "BonBon游戏" : undefined,
        content: semanticSearchCalls === 1 ? `第一条查询独有摘录。${"甲".repeat(3_000)}`
          : semanticSearchCalls === 2 ? `第二条查询独有条件摘录。${"乙".repeat(3_000)}`
          : "另一查询的摘录。" },
        { title: "不安全链接", link: "javascript:alert(1)", content: "不得成为来源链接" }];
    }, async enrichResults(results, signal) {
      if (signal) {
        assert.equal(signal, searchRequests.at(-1)?.signal, "page retrieval shares the active research deadline");
      }
      return results.map((source) => ({ ...source,
        verificationContent: semanticScopeRelevanceMode
          ? "2025-07-17发布于北京腾讯游戏官方账号。该攻略分别列出马可波罗棋手和上阵英雄。核心机制是将棋手与上阵英雄分别列出。完整攻略正文的其他内容。".repeat(8)
          : "2025-07-17发布于北京腾讯游戏官方账号。该攻略分别列出马可波罗棋手和上阵英雄。核心机制见另一条摘录，相关描述可在此核实。完整攻略正文的其他内容。".repeat(8),
        fullPageFetched: true }));
    } },
  }, { id: "witch", version: "test", sourcePath: "test", instructions: "保持简洁。" });
  semanticSearchMode = true;
  semanticSelfDescriptionMode = true;
  semanticCoveragePageNoteMode = true;
  semanticScopeSchemaOmitOnce = true;
  const searchAbort = new AbortController();
  const searchReply = await searchBrain.reply({ conversationId: "onebot:private:search",
    text: "王者万象棋里马可养猪流怎么配队？请区分棋手和上阵英雄。", attachments: [], signal: searchAbort.signal });
  semanticCoveragePageNoteMode = false;
  assert.match(searchReply.text, /我查到的攻略/);
  assert.doesNotMatch(searchReply.text, /官方指定玩法/,
    "claims tied only to insufficient evidence cards are quarantined before rendering");
  assert.equal(semanticSearchCalls, 3, "the model may request up to three distinct focused searches");
  const currentTurnSearchRequests = searchRequests.slice(-3);
  assert.ok(currentTurnSearchRequests.every((item) => item.context?.requestedPoints?.length > 0),
    "each provider search receives the current plan's explicit answer points");
  assert.ok(currentTurnSearchRequests.every((item) => Array.isArray(item.context?.responseConstraints)),
    "each provider search receives answer constraints separately from factual points");
  assert.ok(currentTurnSearchRequests.every((item) => !Object.hasOwn(item.context, "recentContext")),
    "retrieval context does not forward conversation history");
  assert.equal(semanticSearchModelCalls, 8, "search turn includes one bounded schema repair and one lightweight natural-expression call after answer review");
  assert.match(semanticScopeReviewRequest.messages.at(-1).content, /上一版缺少合法的严格 JSON 字段/u,
    "an incomplete scope-review object gets one bounded format repair instead of aborting web search immediately");
  assert.equal(semanticReviewRequest.reasoning_effort, "low", "evidence review uses the lowest supported GLM-5.3-Flash reasoning effort");
  assert.equal(semanticReviewRequest.thinking.type, "enabled", "GLM-5.3-Flash does not support disabling its thinking mode");
  assert.match(semanticReviewRequest.messages[0].content, /不等于它不存在/,
    "evidence review must not turn missing search results into a negative claim");
  assert.match(semanticReviewRequest.messages[0].content, /evidenceScope=retrieval-limit、status=insufficient/,
    "a missing name or official rule is represented as a retrieval gap rather than a supported negative fact");
  assert.match(semanticReviewRequest.messages[0].content, /不得算作独立交叉印证/,
    "syndicated duplicates must not be presented as independent corroboration");
  assert.match(semanticReviewRequest.messages[0].content, /evidenceGroupId 相同表示来源 URL 或正文指纹重复/,
    "the evidence reviewer must honor locally-derived duplicate groups");
  assert.match(semanticReviewRequest.messages[0].content, /可选.*核心配置/,
    "strategy review must preserve optional-versus-core conditions");
  assert.match(semanticReviewRequest.messages[0].content, /‘将\/计划\/拟\/即将开启’只支持/,
    "evidence review must preserve announced plans instead of upgrading them to completed events");
  assert.match(semanticReviewRequest.messages[0].content, /发布时间早于活动计划日期的文章/,
    "evidence review must compare publication time with the event date before asserting completion");
  assert.match(semanticReviewRequest.messages[0].content, /最多 8 张卡、每张最多 2 条引文、每条引文最多 280 字/,
    "evidence review has a strict output-size budget while retaining short exact source quotes");
  assert.match(semanticReviewRequest.messages[0].content, /通常每个问项只建一张综合卡/,
    "evidence review groups source variants under the requested question point instead of repeating one card per source");
  assert.match(semanticReviewRequest.messages[0].content, /最多 6 条缺口、6 条 reviewerNotes、3 条 sourceDisclosures/,
    "evidence review bounds all variable-length evidence sections to prevent token overflow");
  assert.match(semanticReviewRequest.messages[0].content, /只有在两个来源讨论同一技能\/事实方面、同一触发动作/,
    "different triggers or abilities are not automatically mislabeled as contradictory evidence");
  assert.match(semanticAnswerAuditRequest.messages[0].content, /必须核对两边是否讨论同一技能\/事实方面、同一触发动作/,
    "the answer auditor checks conflict scope and trigger compatibility rather than only quote existence");
  const answerAuditPayload = JSON.parse(semanticAnswerAuditRequest.messages.find(message => message.role === "user").content);
  assert.deepEqual(answerAuditPayload.sourceCoveragePages.map(page => page.sourceId), [1, 2],
    "the independent answer auditor receives pages named by retrieval gaps and source-coverage risk notes");
  assert.match(answerAuditPayload.sourceCoveragePages[0].text, /完整攻略正文的其他内容/u,
    "the independent answer auditor can compare gap claims against the fetched page body");
  assert.match(answerAuditPayload.sourceCoveragePages[1].text, /完整攻略正文的其他内容/u,
    "the independent answer auditor also receives full text for source-coverage assertions in reviewer notes");
  assert.match(semanticAnswerAuditRequest.messages[0].content, /必须能从本次实际提供的来源清单与 evidenceGroupId 直接核算/,
    "source-count claims are checked against this retrieval set and cannot be extrapolated");
  assert.equal(searchRequests[0].query, "王者万象棋 马可养猪流 阵容 棋手 上阵英雄");
  assert.equal(searchRequests[1].query, "王者万象棋 马可养猪流 运营阶段 条件");
  assert.equal(searchRequests[2].query, "王者万象棋 马可养猪流 适用版本");
  assert.ok(searchRequests[0].signal instanceof AbortSignal, "the composed turn deadline reaches the search provider");
  assert.match(semanticSynthesisRequest.messages.filter(message => message.role === "tool")[0].tool_call_id, /^web-search-/);
  assert.match(semanticSynthesisRequest.messages.find(message => message.role === "tool").content, /https:\/\/news\.qq\.com\/rain\/a\/example/);
  assert.equal(semanticSynthesisRequest.max_tokens, 3000,
    "structured answer synthesis has enough output budget for detailed multi-part questions");
  const evidenceRequest = semanticSynthesisRequest.messages.find(message => message.role === "tool");
  const evidencePayload = JSON.parse(evidenceRequest.content);
  assert.deepEqual(evidencePayload.evidenceReview.reviewerNotes[0].sourceIds, [2],
    "reviewer caveats stay bound to the source they qualify");
  assert.deepEqual(evidencePayload.evidenceReview.reviewerNotes[0].requestedPointIds, [1],
    "reviewer caveats stay bound to the requested point they qualify");
  assert.equal(evidencePayload.evidenceReview.reviewerNotes[0].riskType, "entity");
  assert.match(evidencePayload.evidenceReview.reviewerNotes[0].note, /另一款游戏/u,
    "a detected temporal/entity mismatch is not silently dropped before answer synthesis");
  assert.equal(evidencePayload.evidenceReview.reviewerNotes.length, 1,
    "ordinary factual findings are never relabeled and forwarded as reviewer risk notes");
  const synthesisPromptText = semanticSynthesisRequest.messages.filter(message => message.role === "system").map(message => message.content).join("\n");
  assert.match(synthesisPromptText, /reviewerNotes 是审查器生成的风险提示，不是原文、事实或引用依据/u,
    "synthesis is explicitly forbidden from treating review notes as source evidence");
  assert.ok(synthesisPromptText.includes("事后报道直接引述‘已于某日公映/已发生’时"),
    "synthesis must prefer a supported post-event confirmation over a pre-event plan when asked for the actual date");
  assert.ok(synthesisPromptText.includes("事后媒体已明确转述公告确认事实发生"),
    "synthesis must prefer a dated media report relaying an official announcement over a weaker encyclopedia-only attribution");
  assert.ok(synthesisPromptText.includes("正文应简洁覆盖这些已核实模块"),
    "synthesis must cover the distinct verified modules in a broad core-gameplay question instead of collapsing to one feature");
  assert.ok(synthesisPromptText.includes("事实卡是否分别直接支持两边"),
    "synthesis must not infer a second same-name entity when evidence supports only one role");
  assert.ok(synthesisPromptText.includes("触发者、资源提供者、转化者或受益者"),
    "synthesis must preserve the different functions of named participants in a mechanism chain");
  const evidence = JSON.parse(evidenceRequest.content).evidenceReview;
  assert.ok(evidence.cards[0].quotes.length <= 2,
    "a model overproducing a few quotes is safely reduced to the bounded source-verified subset");
  assert.equal("finding" in evidence.cards[0], false,
    "synthesis receives exact source quotes and typed point ids, not model-written card summaries that could introduce unsupported facts");
  assert.equal(evidence.cards[0].status, "supported", "source-bound verbatim evidence passes review");
  assert.equal(evidence.cards[1].evidenceScope, "retrieval-limit");
  assert.equal(evidence.cards[1].status, "insufficient",
    "a retrieval-boundary statement cannot be promoted to a supported fact even when the model marks it supported");
  assert.equal(evidence.cards[1].quotes.length, 0,
    "a search gap has no fabricated quotation to support a negative claim");
  assert.equal(evidence.cards[1].status, "insufficient", "model-invented quotations cannot pass source verification");
  assert.equal(evidence.cards[3].status, "insufficient",
    "identical bodies on different domains cannot count as an independent conflict");
  assert.equal(evidence.sourceDisclosures[0].quote, "2025-07-17发布于北京腾讯游戏官方账号",
    "page identity wording is retained only as a locally verified verbatim disclosure");
  assert.equal(evidence.sourceDisclosures.length, 1,
    "unverifiable page identity disclosures are dropped");
  assert.equal(evidence.gaps[0].text, "真实强度与适用版本未被正文证明");
  assert.deepEqual(evidence.gaps[0].sourceIds, [1],
    "retrieval gaps remain bound to the exact pages whose coverage they describe");
  assert.deepEqual(evidence.sourceCoveragePages.map(page => page.sourceId), [1, 2],
    "the answer/audit context receives full text only for pages named by a retrieval gap or source-coverage risk note");
  assert.match(evidence.sourceCoveragePages[0].text, /完整攻略正文的其他内容/u,
    "source-coverage auditing uses the locally fetched page body rather than search snippets alone");
  assert.match(semanticAnswerAuditRequest.messages[0].content, /正文里出现相关信息时，拒绝该缺口/u,
    "the independent answer audit must reject a limitation contradicted by the named full page");
  assert.ok(evidence.cards.some(card => card.status === "insufficient"
    && card.requestedPointIds.includes(1)
    && card.evidenceScope === "retrieval-limit"
    && card.quotes.length === 0),
  "a typed gap must become an insufficient evidence card that the answer can cite as a limitation");
  assert.equal(JSON.parse(evidenceRequest.content).sources.length, 2, "duplicate pages across query passes are deduplicated before evidence review");
  assert.equal(JSON.parse(semanticReviewRequest.messages[1].content).sources[0].evidenceGroupId,
    JSON.parse(semanticReviewRequest.messages[1].content).sources[1].evidenceGroupId,
    "the model receives program-derived duplicate-evidence groups");
  const reviewedSources = JSON.parse(semanticReviewRequest.messages[1].content).sources;
  assert.match(reviewedSources[0].content, /第一条查询独有摘录/);
  assert.match(reviewedSources[0].content, /第二条查询独有条件摘录/,
    "same-page results from distinct queries merge their excerpts instead of last-result-wins replacement");
  assert.match(reviewedSources[0].content,
    /【检索词：王者万象棋 马可养猪流 阵容 棋手 上阵英雄】\n第一条查询独有摘录/,
    "each retained excerpt remains bound to the query that retrieved it");
  assert.match(reviewedSources[0].content,
    /【检索词：王者万象棋 马可养猪流 运营阶段 条件】\n第二条查询独有条件摘录/);
  assert.ok(reviewedSources[0].content.length <= 3_000,
    "merged query excerpts stay within the per-source model-context budget");
  assert.equal(reviewedSources[0].fullPageFetched, true,
    "the reviewer is told when full page text was fetched");
  assert.doesNotMatch(reviewedSources[0].content, /该攻略分别列出/,
    "full page text is not poured into the model context");
  assert.match(searchReply.text, /\[媒体平台来源1\]\(https:\/\/news\.qq\.com\/rain\/a\/example\)/,
    "hosting platform is rendered separately from the page-author claim");
  assert.match(searchReply.text, /核心机制。 \[媒体平台来源1\]\(https:\/\/news\.qq\.com\/rain\/a\/example\) 该账号自称为官方，但身份未经独立核验。 \[媒体平台来源1\]\(https:\/\/news\.qq\.com\/rain\/a\/example\)/,
    "paragraph cites only a source bound to its reviewed evidence cards");
  assert.doesNotMatch(searchReply.text, /官方指定玩法/,
    "a claim cannot label an unverified-domain citation as an official statement");
  assert.match(searchReply.text, /自称为官方，但身份未经独立核验/,
    "a quoted self-description can be accurately distinguished from independently verified official status");
  assert.match(searchReply.text, /媒体或社区资料不代表官方结论/,
    "answers without publisher-verified evidence explain the provenance limit");
  assert.match(searchReply.text, /来源索引：\n- \[媒体平台来源1：腾讯新闻托管的账号文章\].*页面作者字段“BonBon游戏”（未独立认证）.*页面自述摘录（未独立认证）：“2025-07-17发布于北京腾讯游戏官方账号”/,
    "the source index distinguishes hosting media, author metadata, and the page's verbatim account statement");
  assert.match(semanticReviewRequest.messages[0].content, /author 是搜索提供方或页面元数据给出的作者字段，只是未经认证的页面声明/,
    "the evidence reviewer must not promote author metadata to verified publisher identity");
  assert.match(semanticReviewRequest.messages[0].content, /sourceKind=disclosure/,
    "the evidence reviewer distinguishes issuer-owned sites from the public-company disclosure host");
  assert.match(semanticReviewRequest.messages[0].content, /它只证明页面这样自述，不证明身份已独立认证/,
    "page self-description is retained without treating it as independent authentication");
  const synthesisInstructions = semanticSynthesisRequest.messages.filter(message => message.role === "system").map(message => message.content).join("\n");
  assert.match(synthesisInstructions, /开头先直接回答用户最核心的问项/,
    "the evidence answer should lead with the requested conclusion in Witch's natural voice");
  assert.match(synthesisInstructions, /不要写成机械审查报告/,
    "source-backed answers must retain Witch's natural voice");
  assert.match(synthesisInstructions, /只可使用给定事实卡/);
  assert.match(synthesisInstructions, /必须在正文中明确回答/,
    "the answer must state requested facts directly, not hide them in citations");
  assert.match(synthesisInstructions, /不因资料里出现就额外加入票房/,
    "the answer must not expand into unrelated retrieved details");
  assert.match(synthesisInstructions, /evidenceRefs/);
  assert.match(synthesisInstructions, /sourceAttribution/,
    "structured claims must state whether official status is verified, merely self-described, or not asserted");
  assert.match(synthesisInstructions, /不要在 text 中输出来源编号/);
  assert.match(synthesisInstructions, /程序会从引文绑定来源/);
  assert.match(synthesisInstructions, /limitations 专门表达/);
  assert.match(synthesisInstructions, /按来源分别列出证据卡实际支持的具体内容/,
    "source comparisons must preserve concrete evidence-backed variants instead of collapsing them into uncertainty");
  assert.match(synthesisInstructions, /不得把部分来源扩大成‘各攻略一致\/普遍如此’/,
    "agreement language must be scoped to the independent sources that actually support the point");
  assert.match(synthesisInstructions, /像小巫在给主人讲清楚一件事/,
    "complex research answers must connect evidence into a natural explanation, not a card dump");
  assert.match(synthesisInstructions, /不能只列出完整名单或解释其中几个/,
    "answers to enumerated mechanism questions must explain each requested item rather than only name them");
  assert.match(synthesisInstructions, /逐来源写明来源日期及其明确标注的版本范围/,
    "conflicting rules must retain their source date and stated version scope");
  assert.match(synthesisInstructions, /不要顺手堆入未被问到的赛季宣传/,
    "a work overview must stay focused on its core gameplay instead of unrelated recency tangents");
  assert.match(synthesisInstructions, /画面风格、配音、商业模式、抽取机制和营销卖点不因被检索到就算核心玩法/,
    "retrieved presentation and monetization facts are excluded from a core-gameplay answer unless requested");
  assert.match(synthesisInstructions, /若证据只支持系统\/类型标签而没有说明实际玩法循环，简短指出这个缺口/,
    "the answer must not turn marketing/system labels into an invented gameplay loop");
  assert.match(synthesisInstructions, /至少给出一条有效 limitation/);
  assert.match(synthesisInstructions, /总正文不超过 2000 个汉字/);
  assert.match(synthesisInstructions, /group 只用于展示分段，合法编号范围为 1–10/,
    "complex research limitations are not silently dropped when they use more than four presentation groups");
  assert.deepEqual(semanticSynthesisRequest.response_format, { type: "json_object" });
  assert.equal(semanticSynthesisRequest.max_tokens, 3000);
  assert.equal(semanticSynthesisRequest.reasoning_effort, "low");
  assert.match(semanticExpressionRequest.messages[0].content, /不能变成来源审计报告/,
    "the natural expression stage turns audited facts into user-facing explanation instead of a source audit report");
  assert.match(semanticExpressionRequest.messages[0].content, /只有 sourceAttribution=verified-publisher 才能称为发布方\/官方信息/,
    "natural expression cannot upgrade an unverified platform or media source into official attribution");
  assert.match(semanticExpressionRequest.messages[0].content, /普通问题通常1到2段、约100到300个汉字/,
    "natural expression keeps ordinary answers compact instead of narrating every retrieval detail");
  assert.match(semanticExpressionRequest.messages[0].content, /多个明确问项可到3段、最多450字/,
    "multi-point answers retain room for user-requested coverage without defaulting to a long report");
  assert.match(semanticExpressionRequest.messages[0].content, /不要增加.*核准要点中没有的行动建议/,
    "natural expression cannot add generic next-step advice outside the approved evidence contract");
  assert.match(semanticExpressionRequest.messages[0].content, /排除条件只需遵守/,
    "response constraints are followed without introducing excluded or neighboring topics");
  assert.match(semanticExpressionRequest.messages[0].content, /有限官方网页中的不同命名/,
    "natural expression must preserve the retrieval scope when contrasting official and community names");
  assert.equal(semanticNarrativeAuditCalls, 0,
    "the lightweight expression path does not spend another model call on a second style audit");
  const semanticExpressionPayload = JSON.parse(semanticExpressionRequest.messages[1].content);
  assert.match(semanticExpressionPayload.witchPersonality, /保持简洁/,
    "the user-facing expression stage receives Witch's provider-independent communication style");
  assert.equal(semanticExpressionPayload.approvedPoints[0].sourceAttribution, "none");
  assert.equal(semanticExpressionPayload.approvedPoints[0].sourceKinds[0].sourceKind, "media",
    "each approved point carries provenance so expression cannot silently upgrade source authority");
  assert.equal(semanticExpressionPayload.sourceMetadata[0].sourceKind, "media");
  assert.match(searchReply.text, /我查到的攻略把棋手和上阵英雄分开写/);
  assert.match(searchReply.text, /\[媒体平台来源1\]\(https:\/\/news\.qq\.com\/rain\/a\/example\)/,
    "paragraph citations are generated from the structured approved claim references");
  semanticSelfDescriptionMode = false;
  const priorSemanticRequests = {
    synthesis: semanticSynthesisRequest,
    repair: semanticRepairRequest,
    answerAudit: semanticAnswerAuditRequest,
    relevanceAudit: semanticRelevanceAuditRequest,
    expression: semanticExpressionRequest,
    narrativeAudit: semanticNarrativeAuditRequest,
  };
  semanticMissingEvidenceRefsMode = true;
  const beforeMissingEvidenceRefsRepair = semanticSynthesisCalls;
  const repairedMissingEvidenceRefsReply = await searchBrain.reply({ conversationId: "onebot:private:missing-evidence-refs",
    text: "查证一个核心机制并说明证据范围。", attachments: [] });
  semanticMissingEvidenceRefsMode = false;
  assert.match(repairedMissingEvidenceRefsReply.text, /来源将棋手与上阵英雄分别列出/u,
    "a claim without exact citations is rejected and repaired rather than delivered");
  assert.equal(semanticSynthesisCalls - beforeMissingEvidenceRefsRepair, 2,
    "the malformed no-citation claim receives one bounded structural repair");
  const missingRefsRepairPayload = JSON.parse(semanticRepairRequest.messages.at(-1).content);
  assert.match(missingRefsRepairPayload.previousRawAnswer, /evidenceRefs":\[\]/u,
    "the repair receives the exact malformed draft rather than only a generic schema error");
  assert.match(missingRefsRepairPayload.issues.join(" "), /missing evidenceRefs/u,
    "the validator gives a field-specific repair diagnosis");
  semanticSynthesisRequest = priorSemanticRequests.synthesis;
  semanticRepairRequest = priorSemanticRequests.repair;
  semanticAnswerAuditRequest = priorSemanticRequests.answerAudit;
  semanticRelevanceAuditRequest = priorSemanticRequests.relevanceAudit;
  semanticExpressionRequest = priorSemanticRequests.expression;
  semanticNarrativeAuditRequest = priorSemanticRequests.narrativeAudit;
  const auditPrompt = semanticAnswerAuditRequest.messages.find(message => message.role === "system").content;
  const auditPayload = JSON.parse(semanticAnswerAuditRequest.messages[1].content);
  assert.ok(auditPayload.evidenceReviewCards.reviewerNotes.some(note => /另一款游戏/u.test(note.note)),
    "the final answer auditor sees the same source caveat as the synthesis stage");
  assert.match(auditPrompt, /未能排除风险时拒绝依赖该来源的 claim/u,
    "the independent answer audit must reject claims that rely on unresolved source mismatch warnings");
  assert.match(auditPrompt, /approved=true.*issues.*必须是空数组/u,
    "a successful audit must use empty rejection and issue arrays so the client does not spend a retry reconciling contradictory metadata");
  assert.match(auditPrompt, /sourceAttribution.*self-description/,
    "the independent fact auditor distinguishes verified publishers from pages that merely self-identify as official");
  assert.match(auditPrompt, /少数页面或搜索摘要不能证明全网\/官方从未提及/,
    "fact audit rejects universal absence claims based only on the pages retrieved in this run");
  assert.match(auditPrompt, /每条事实主张都必须/);
  assert.match(auditPrompt, /范围漂移/);
  assert.match(auditPrompt, /是否逐项直接回应/,
    "the independent audit checks coverage of every explicit question point");
  assert.match(auditPrompt, /任何明确问项既无有据 claim、也无有效 limitation/,
    "an incomplete answer is regenerated instead of being accepted as merely concise");
  assert.match(auditPrompt, /绑定到 insufficient 卡的 limitation/,
    "an evidence-bound uncertainty can answer an explicit question point without inventing a fact");
  assert.match(auditPrompt, /只说‘有差异\/不能确定唯一方案’却不列出这些具体内容，属于漏答/,
    "the answer audit rejects vague uncertainty when sources contain concrete requested variants");
  assert.match(auditPrompt, /检查‘共同\/一致\/都\/各攻略\/普遍’等共识措辞的范围/,
    "the answer audit rejects consensus claims broader than independent evidence supports");
  assert.match(auditPrompt, /卡片式罗列/,
    "the answer audit requires a connected explanation for complex evidence");
  assert.match(auditPrompt, /只列对象名字、或仅解释部分对象，不能算完整回答/,
    "the answer audit checks completeness across each enumerated mechanism or trigger");
  assert.match(auditPrompt, /不同来源的数量\/规则冲突/,
    "the answer audit checks date and version scope for conflicts");
  assert.match(auditPrompt, /未被问到的赛季、限时活动或旧开服细节/,
    "the answer audit rejects unrelated product-overview tangents");
  assert.match(auditPrompt, /仅描述画面风格、配音、商业模式\/抽取机制或宣传卖点的 claim 即使逐字引文支持，也与核心玩法无关/,
    "the answer audit rejects evidence-backed but out-of-scope gameplay tangents");
  assert.match(semanticReviewRequest.messages[0].content, /把玩家实际反复进行的行动、选择和主要内容循环当作核心要点/,
    "evidence selection prioritizes player activities over promotional feature lists");
  assert.match(semanticReviewRequest.messages[0].content, /优先为每个对象分别建立证据卡/,
    "evidence review preserves per-entity mechanics instead of collapsing an enumerated list");
  assert.ok(auditPrompt.includes("明确写‘公告显示/据公司公告’"),
    "the audit treats articles relaying a filing as derivative rather than independent corroboration");
  assert.match(auditPrompt, /事后状态确认，不是‘定档依据’/,
    "the audit distinguishes an after-release confirmation from a pre-release scheduling notice");
  assert.match(auditPrompt, /‘将\/计划\/拟\/即将开启’只能证明/,
    "answer audit must reject future plans rewritten as completed events");
  assert.match(auditPrompt, /发布于计划日期之前的文章，无论标题写/,
    "answer audit must not treat pre-event articles as evidence that the event occurred");
  assert.ok(auditPrompt.includes("若已提供明确转述公告的事后媒体原文"),
    "answer audit must reject source attribution that downgrades a stronger available quote to encyclopedia-only evidence");
  assert.ok(auditPrompt.includes("必须逐项对照所有对应的 supported 事实卡"),
    "answer audit must compare a broad gameplay answer against all relevant supported evidence cards");
  assert.ok(auditPrompt.includes("只由一条引文证明棋手/账号/产品其中一侧"),
    "answer audit must reject unsupported identity transfer between same-name roles or entities");
  assert.ok(auditPrompt.includes("触发者、资源提供者、转化者和受益者不能因为出现在同一玩法里就互换"),
    "answer audit must not collapse different mechanism roles into one unsupported core entity");
  assert.deepEqual(JSON.parse(semanticAnswerAuditRequest.messages[1].content).answer.claims[0].evidenceRefs,
    [{ cardId: 1, quoteId: 0 }, { cardId: 3, quoteId: 0 }]);
  assert.equal(JSON.parse(semanticAnswerAuditRequest.messages[1].content).sourceMetadata[0].sourceKind, "media");
  assert.equal(JSON.parse(semanticAnswerAuditRequest.messages[1].content).sourceMetadata[0].authorClaim, "BonBon游戏",
    "the answer auditor receives author metadata as a claim, not as verified identity");
  assert.equal(
    JSON.parse(semanticAnswerAuditRequest.messages[1].content).sourceMetadata[0].evidenceGroupId,
    JSON.parse(semanticAnswerAuditRequest.messages[1].content).sourceMetadata[1].evidenceGroupId,
    "the independent answer audit receives duplicate-evidence grouping too",
  );
  assert.equal(typeof JSON.parse(semanticAnswerAuditRequest.messages[1].content).sourceMetadata[0].evidenceGroupId, "number",
    "duplicate-evidence group ids are present rather than both being omitted");
  assert.deepEqual(JSON.parse(semanticReviewRequest.messages[1].content).requestedPoints,
    [{ id: 1, text: "用户当前问到的核心机制或事实", independentSupportRequired: false }],
    "evidence review receives atomic requested facts as numbered points");
  assert.match(semanticScopeReviewRequest.messages[0].content, /把限制条件、否定要求、格式要求或来源要求误拆成待回答事实/);
  assert.match(semanticScopeReviewRequest.messages[0].content, /两个实体、角色或方案时，必须拆成每侧各自可回答的独立问项/,
    "scope review separates both sides of an explicit entity comparison");
  assert.match(semanticReviewRequest.messages[0].content, /必须为每一侧建立单独卡片/,
    "evidence review keeps each side of a disambiguation question on its own evidence card");
  assert.match(semanticScopeReviewRequest.messages[0].content, /只有当用户明确要求多个独立来源共同支持/,
    "cross-source requirements are classified by semantic review, not by keyword or regex routing");
  assert.deepEqual(JSON.parse(semanticScopeReviewRequest.messages[1].content).candidatePoints,
    [{ id: 1, text: "用户当前问到的核心机制或事实", independentSupportRequired: false }],
    "independent scope review receives planner candidates for verification against the original user message");
  assert.deepEqual(JSON.parse(semanticReviewRequest.messages[1].content).responseConstraints,
    ["不要把相似玩法混在一起"],
    "answer constraints are preserved separately and are not treated as factual points");
  assert.deepEqual(JSON.parse(semanticAnswerAuditRequest.messages[1].content).requestedPoints,
    [{ id: 1, text: "用户当前问到的核心机制或事实", independentSupportRequired: false }],
    "independent audit receives the same question-point contract");
  assert.deepEqual(JSON.parse(semanticRelevanceAuditRequest.messages[1].content).requestedPoints,
    [{ id: 1, text: "用户当前问到的核心机制或事实", independentSupportRequired: false }],
    "a separate answer-relevance gate checks actual claim text against the point, not just model-assigned tags");
  assert.deepEqual(JSON.parse(semanticRelevanceAuditRequest.messages[1].content).responseConstraints,
    ["不要把相似玩法混在一起"],
    "relevance review receives constraints separately so it will not turn them into extra answer topics");
  const relevanceInstructions = semanticRelevanceAuditRequest.messages[0].content;
  assert.match(relevanceInstructions, /requestedPointIds 只是生成模型自报的标签/);
  assert.match(relevanceInstructions, /开发商、发行、发布日期、商业模式等相邻信息/);
  assert.equal(semanticAnswerAuditRequest.max_tokens, 3000);
  assert.match(semanticAnswerAuditRequest.messages[0].content, /缺少一手页面不能覆盖或抹掉同一问项已有的二手事后确认/u,
    "answer audit rejects an overbroad uncertainty limitation when the same point has supported post-event evidence");

  const reviewsBeforeTruncatedEvidence = semanticSearchReviewCalls;
  semanticTruncatedEvidenceOnce = true;
  const truncatedEvidenceReply = await searchBrain.reply({ conversationId: "onebot:private:truncated-evidence",
    text: "查一下马可养猪流的配队。", attachments: [] });
  assert.match(truncatedEvidenceReply.text, /我查到的攻略/,
    "a syntactically valid but token-truncated evidence response is repaired before it can drive an answer");
  assert.equal(semanticSearchReviewCalls - reviewsBeforeTruncatedEvidence, 2,
    "finish_reason=length triggers exactly one compact same-source evidence repair");
  assert.match(semanticReviewRequest.messages[0].content, /model output was truncated at the token limit/,
    "the repair prompt receives the explicit truncation reason rather than trusting partial JSON");
  assert.deepEqual(semanticReviewRequest.messages.map((message) => message.role), ["system", "user", "user"],
    "a truncated partial assistant JSON is not fed back as repair context; the model restarts from the original source batch");

  const narrativeAuditCallsBeforeMvp = semanticNarrativeAuditCalls;
  semanticRejectNarrativeAudits = true;
  const expressionMvpReply = await searchBrain.reply({ conversationId: "onebot:private:expression-mvp",
    text: "查一下马可养猪流的配队。", attachments: [] });
  semanticRejectNarrativeAudits = false;
  assert.equal(semanticNarrativeAuditCalls - narrativeAuditCallsBeforeMvp, 0,
    "lightweight expression does not invoke the removed style-audit stage");
  assert.match(expressionMvpReply.text, /我查到的攻略把棋手和上阵英雄分开写/u,
    "the audited natural wording survives without an additional model approval or free rewrite");
  assert.match(semanticExpressionRequest.messages[0].content, /普通问题通常1到2段、约100到300个汉字/u,
    "natural expression defaults to a short, conversational answer instead of a research-report length");
  assert.match(semanticExpressionRequest.messages[0].content, /次要细节可以省略/u,
    "the expression layer may omit low-value evidence details while preserving the approved core facts");
  assert.match(expressionMvpReply.text, /来源索引：/u,
    "citations remain attached by the program after natural expression");

  semanticMalformedExpressionOnce = true;
  const malformedExpressionReply = await searchBrain.reply({ conversationId: "onebot:private:expression-format-fallback",
    text: "查一下马可养猪流的配队。", attachments: [] });
  assert.match(malformedExpressionReply.text, /来源索引：/u,
    "malformed expression output falls back to the verified source-linked answer instead of breaking delivery");
  assert.match(malformedExpressionReply.text, /我查到的攻略把棋手和上阵英雄分开写/u,
    "the formatting fallback retains the evidence-checked answer content");

  semanticOverlongExpressionOnce = true;
  const overlongExpressionReply = await searchBrain.reply({ conversationId: "onebot:private:expression-length-fallback",
    text: "查一下马可养猪流的配队。", attachments: [] });
  assert.match(overlongExpressionReply.text, /来源索引：/u,
    "an overlong natural expression falls back to the verified source-linked answer");
  assert.doesNotMatch(overlongExpressionReply.text, /过长/u,
    "the expression-length limit prevents an oversized report-like answer from being delivered");

  const beforeFollowupSearches = semanticSearchCalls;
  const beforeFollowupModels = semanticSearchModelCalls;
  const beforeFollowupReviews = semanticSearchReviewCalls;
  semanticFollowupMode = true;
  semanticFollowupReviewPasses = 0;
  semanticMalformedFollowupReviewOnce = true;
  const followupBrain = new GlmBrain({
    apiKey: "test-key", baseUrl: `http://127.0.0.1:${address.port}`, model: "glm-5.3-flash",
    reasoningEffort: "high", maxTokens: 4096, timeoutMs: 10_000,
      webSearch: { async searchWithFallback(query, signal) {
      semanticSearchCalls += 1;
      searchRequests.push({ query, signal });
      return [{ title: "发布方规则页", link: "https://example.org/official",
        content: semanticDuplicateFollowupMode
          ? "该攻略分别列出马可波罗棋手和上阵英雄。"
          : query.includes("腾讯游戏") ? "补搜专有摘录。" : `初始查询摘录${semanticSearchCalls}。` }];
    }, async enrichResults(results) {
      return results.map((source) => ({ ...source,
        verificationContent: "该攻略分别列出马可波罗棋手和上阵英雄。核心机制见另一条摘录，相关描述可在此核实。",
        fullPageFetched: true }));
    } },
  }, { id: "witch", version: "test", sourcePath: "test", instructions: "保持简洁。" });
  const followupReply = await followupBrain.reply({ conversationId: "onebot:private:followup",
    text: "查证一个关键事实并在需要时补查来源。", attachments: [] });
  assert.match(followupReply.text, /我查到的攻略/);
  assert.equal(semanticSearchCalls - beforeFollowupSearches, 4,
    "the first evidence review can request one bounded follow-up query after the initial three searches");
  assert.equal(semanticSearchModelCalls - beforeFollowupModels, 9,
    "a malformed follow-up review gets one bounded format repair before answer review and one natural-expression call");
  assert.equal(semanticSearchReviewCalls - beforeFollowupReviews, 3,
    "the malformed follow-up evidence review is repaired once without repeating retrieval");
  assert.equal(searchRequests.at(-1).query, "腾讯游戏 王者万象棋 官方规则");
  const followupEvidenceSources = JSON.parse(semanticReviewRequest.messages[1].content).sources;
  assert.match(followupEvidenceSources[0].content, /初始查询摘录/);
  assert.match(followupEvidenceSources[0].content, /补搜专有摘录/,
    "follow-up results for an existing URL merge their excerpt without creating a second source");
  assert.match(followupEvidenceSources[0].content,
    /【检索词：腾讯游戏 王者万象棋 官方规则】\n补搜专有摘录/,
    "follow-up excerpts keep their own query provenance after merging with prior evidence");
  assert.equal(followupEvidenceSources.length, 1,
    "same URL remains one source after merging a follow-up query excerpt");
  assert.match(semanticReviewRequest.messages[0].content, /严格遵守原 schema 上限：最多 8 张卡、每张最多 2 条引文/,
    "a malformed evidence-review retry uses the same explicit compact schema limits");
  semanticFollowupMode = false;

  const beforeUnreviewableFollowupModels = semanticSearchModelCalls;
  semanticFollowupMode = true;
  semanticFollowupReviewPasses = 0;
  semanticMalformedFollowupReviewAlways = true;
  const unreviewableFollowupReply = await followupBrain.reply({ conversationId: "onebot:private:followup-fallback",
    text: "查证一个关键事实并在需要时补查来源。", attachments: [] });
  semanticFollowupMode = false;
  semanticMalformedFollowupReviewAlways = false;
  assert.match(unreviewableFollowupReply.text, /我查到的攻略/,
    "a malformed optional follow-up review must not discard the already verified initial evidence");
  assert.equal(semanticSearchModelCalls - beforeUnreviewableFollowupModels, 9,
    "failed follow-up validation retains the bounded initial answer workflow after one repair attempt");
  const retainedEvidencePayload = JSON.parse(semanticSynthesisRequest.messages.find(message => message.role === "tool").content);
  assert.equal(retainedEvidencePayload.sources.length, 1,
    "unreviewed follow-up material is excluded from the answer evidence set");
  assert.match(retainedEvidencePayload.partialRetrievalFailures.join(" "), /follow-up evidence review/,
    "the answer layer receives an explicit follow-up review failure so it can disclose the unresolved gap");

  semanticFollowupMode = true;
  semanticDuplicateFollowupMode = true;
  semanticFollowupReviewPasses = 0;
  semanticMalformedFollowupReviewOnce = false;
  const beforeDuplicateFollowupReviews = semanticSearchReviewCalls;
  const duplicateFollowupReply = await followupBrain.reply({ conversationId: "onebot:private:duplicate-followup",
    text: "查证一个关键事实并在需要时补查来源。", attachments: [] });
  assert.match(duplicateFollowupReply.text, /我查到的攻略/u);
  assert.equal(semanticSearchReviewCalls - beforeDuplicateFollowupReviews, 1,
    "a follow-up that returns only the same URL and quoted passage does not rerun evidence review on a duplicated large corpus");
  semanticFollowupMode = false;
  semanticDuplicateFollowupMode = false;

  const beforeRepairSynthesis = semanticSynthesisCalls;
  const beforeRepairAudits = semanticAnswerAuditCalls;
  semanticRejectAnswerFirst = true;
  semanticAnswerRejected = false;
  const repairedReply = await searchBrain.reply({ conversationId: "onebot:private:repair",
    text: "查一下马可养猪流的配队，并说明证据范围。", attachments: [] });
  assert.match(repairedReply.text, /我查到的攻略/,
    "an answer rejected for unsupported claims is regenerated from the reviewed evidence");
  assert.doesNotMatch(repairedReply.text, /胜率最高|官方指定玩法/,
    "unsupported claims from a rejected draft never reach the user");
  assert.equal(semanticSynthesisCalls - beforeRepairSynthesis, 2,
    "a rejected answer gets exactly one structured repair attempt");
  assert.equal(semanticTargetedRepairRequest.max_tokens, 3000,
    "the single repair receives the same larger answer budget instead of repeating truncation");
  const repairInstructions = semanticTargetedRepairRequest.messages.find(message => message.role === "system").content;
  assert.match(repairInstructions, /只重写 repairTargets\.rejectedClaims/);
  assert.match(repairInstructions, /已通过审查，必须保持原样/,
    "a targeted repair must preserve accepted claims instead of regenerating the whole answer");
  const repairPayload = JSON.parse(semanticTargetedRepairRequest.messages.at(-1).content);
  assert.match(JSON.stringify(repairPayload.repairTargets.rejectedClaims), /胜率最高/u,
    "the bounded repair sees the exact rejected draft so it can revise or remove the problem claim");
  assert.equal(semanticAnswerAuditCalls - beforeRepairAudits, 2,
    "the repaired answer is independently audited before delivery");
  semanticRejectAnswerFirst = false;

  semanticRepairPruneMode = true;
  semanticRepairPruneAuditStage = 0;
  const beforeRepairPruneSynthesis = semanticSynthesisCalls;
  const beforeRepairPruneAudits = semanticAnswerAuditCalls;
  const selectivelyPrunedReply = await searchBrain.reply({ conversationId: "onebot:private:repair-prune",
    text: "查一下马可养猪流的配队。", attachments: [] });
  assert.match(selectivelyPrunedReply.text, /来源将棋手与上阵英雄分别列出/u,
    "a repair can retain valid claims after the answer auditor rejects one claim");
  assert.doesNotMatch(selectivelyPrunedReply.text, /胜率最高/u,
    "a claim rejected after the single repair is pruned before rendering");
  assert.equal(semanticSynthesisCalls - beforeRepairPruneSynthesis, 3,
    "an answer rejected after repair receives one final bounded repair before claims are pruned");
  assert.equal(semanticAnswerAuditCalls - beforeRepairPruneAudits, 4,
    "the final repaired answer is audited, then audited again after residual rejected claims are quarantined");
  semanticRepairPruneMode = false;

  semanticScopeRelevanceMode = true;
  semanticScopeRelevanceRejected = false;
  const scopePrunedReply = await searchBrain.reply({ conversationId: "onebot:private:scope-relevance",
    text: "查一下马可养猪流的核心机制。", attachments: [] });
  assert.match(scopePrunedReply.text, /核心机制是将棋手与上阵英雄分别列出/u,
    "the relevance gate accepts a supported replacement that cites a different evidence card for the same requested point");
  assert.doesNotMatch(scopePrunedReply.text, /2025年7月17日上线/u,
    "a factual and cited but unrelated clause is removed during repair before delivery");
  const relevanceRepairPayload = JSON.parse(semanticTargetedRepairRequest.messages.at(-1).content);
  assert.match(JSON.stringify(relevanceRepairPayload.repairTargets.rejectedClaims), /游戏于2025年7月17日上线/u,
    "the bounded repair sees the original mixed claim and can preserve its relevant clause while removing the tangent");
  assert.match(semanticTargetedRepairRequest.messages.find(message => message.role === "system").content,
    /repairTargetOriginalIndex/u,
    "targeted repair explicitly identifies which rejected item each replacement must replace");
  assert.equal(relevanceRepairPayload.repairTargets.rejectedClaims[0].originalIndex, 0,
    "the repair payload includes the stable original item index used to prevent same-point claims from being mixed");
  semanticScopeRelevanceMode = false;

  semanticTargetedRepairMode = true;
  semanticTargetedRelevanceCalls = 0;
  semanticTargetedAnswerAuditCalls = 0;
  const beforeTargetedRepairSynthesis = semanticSynthesisCalls;
  const stableClaimReply = await searchBrain.reply({ conversationId: "onebot:private:targeted-repair",
    text: "查一下马可养猪流的核心机制。", attachments: [] });
  assert.match(stableClaimReply.text, /(?:是一款)?MMORPG/u,
    "a later correction must preserve an already-approved answer claim rather than lose the requested point");
  assert.match(stableClaimReply.text, /按公告计划开放/u,
    "the rejected event-state claim is replaced with a bounded, time-accurate correction");
  assert.doesNotMatch(stableClaimReply.text, /腾讯发行并于2025年7月上线/u,
    "the targeted repair cannot reintroduce the unrelated facts from a rejected mixed claim");
  assert.equal(semanticSynthesisCalls - beforeTargetedRepairSynthesis, 3,
    "two distinct rejected claims are repaired without regenerating the previously approved claim");
  const targetedRepairPayload = JSON.parse(semanticTargetedRepairRequest.messages.at(-1).content);
  assert.match(JSON.stringify(targetedRepairPayload.repairTargets.preservedClaims), /是一款MMORPG/u,
    "the final repair receives the exact previously-approved claim to preserve");
  assert.match(JSON.stringify(targetedRepairPayload.repairTargets.rejectedClaims), /团本已经开放/u,
    "the final repair is scoped to the exact claim rejected for event-time drift");
  semanticTargetedRepairMode = false;

  const beforeMalformedAudit = semanticAnswerAuditCalls;
  semanticMalformedAuditOnce = true;
  const formatRetriedReply = await searchBrain.reply({ conversationId: "onebot:private:audit-format-retry",
    text: "查一下马可养猪流的配队。", attachments: [] });
  assert.match(formatRetriedReply.text, /我查到的攻略/,
    "a malformed audit response gets one bounded format retry before safe fallback");
  assert.equal(semanticAnswerAuditCalls - beforeMalformedAudit, 2,
    "malformed answer-audit JSON is retried exactly once");
  semanticMalformedAuditOnce = false;

  semanticMalformedRelevanceOnce = true;
  const beforeMalformedRelevance = semanticSearchModelCalls;
  const relevanceFormatReply = await searchBrain.reply({ conversationId: "onebot:private:relevance-format-retry",
    text: "查一下马可养猪流的配队。", attachments: [] });
  assert.match(relevanceFormatReply.text, /我查到的攻略/,
    "a malformed relevance-audit response receives one bounded schema retry instead of failing the whole answer");
  assert.equal(semanticSearchModelCalls - beforeMalformedRelevance, 8,
    "the relevance format repair adds one model call to the bounded workflow with single-pass expression");
  semanticMalformedRelevanceOnce = false;

  semanticCoverageMode = true;
  semanticCoverageRejected = false;
  const beforeCoverageSynthesis = semanticSynthesisCalls;
  const beforeCoverageAudits = semanticAnswerAuditCalls;
  const coverageReply = await searchBrain.reply({ conversationId: "onebot:private:coverage",
    text: "电影《哪吒之魔童闹海》的内地上映日期是什么？", attachments: [] });
  assert.match(coverageReply.text, /2025年1月29日/,
    "a missing direct answer is rejected and the repair returns the requested date");
  assert.equal(semanticSynthesisCalls - beforeCoverageSynthesis, 2,
    "an answer omitting an explicit requested fact gets one repair attempt");
  assert.equal(semanticAnswerAuditCalls - beforeCoverageAudits, 2,
    "the repaired coverage-complete answer is independently checked");
  semanticCoverageMode = false;

  semanticLimitationsMode = true;
  const limitationsReply = await searchBrain.reply({ conversationId: "onebot:private:limitations",
    text: "查一下马可养猪流的配置；强度和禁用条件若没有可靠版本依据，请明确说无法确认。", attachments: [] });
  assert.match(limitationsReply.text, /强度与禁用条件的适用版本，现有材料没能确认/u,
    "a limitation linked to an insufficient evidence card is delivered instead of triggering a generic synthesis failure");
  const limitationsPayload = JSON.parse(semanticAnswerAuditRequest.messages[1].content);
  assert.deepEqual(limitationsPayload.answer.limitations[0].cardIds, [2],
    "the auditor receives the exact insufficient card that grounds the uncertainty");
  assert.equal(limitationsPayload.evidenceReviewCards.cards[1].status, "insufficient");
  semanticLimitationsMode = false;

  semanticInvalidLimitationMode = true;
  const beforeInvalidLimitationAudit = semanticAnswerAuditCalls;
  const invalidLimitationReply = await searchBrain.reply({ conversationId: "onebot:private:invalid-limitation",
    text: "查一下马可养猪流的配置。", attachments: [] });
  assert.match(invalidLimitationReply.text, /棋手马可与上阵英雄分开介绍/u,
    "an invalid limitation is quarantined without discarding independently grounded claims");
  assert.doesNotMatch(invalidLimitationReply.text, /强度和版本不能确认/u,
    "a limitation linked to a supported card is never rendered");
  assert.equal(semanticAnswerAuditCalls - beforeInvalidLimitationAudit, 1,
    "the retained answer still goes through the independent answer audit");
  assert.deepEqual(JSON.parse(semanticAnswerAuditRequest.messages[1].content).answer.limitations, [],
    "the auditor only receives limitations bound to insufficient cards");
  semanticInvalidLimitationMode = false;

  const beforeCasualCall = semanticSearchCalls;
  const beforeCasualModels = semanticSearchModelCalls;
  const casualReply = await searchBrain.reply({ conversationId: "onebot:private:casual", text: "我今天有点累，陪我聊会儿。", attachments: [] });
  assert.equal(casualReply.text, "测试回复");
  assert.equal(semanticSearchCalls, beforeCasualCall, "ordinary conversation does not trigger web search");
  assert.equal(semanticSearchModelCalls - beforeCasualModels, 2, "ordinary conversation gets a semantic no-search decision, then a natural reply");
  assert.equal(semanticResearchPlans.at(-1).currentMessage, "我今天有点累，陪我聊会儿。");
  console.log("glm smoke: ok");
} finally {
  server.close();
  await fs.rm(tempDir, { recursive: true, force: true });
}
