import assert from "node:assert/strict";
import {
  BraveLlmContextSearch,
  BaiduWebSearch,
  ExaBraveWebSearch,
  ExaWebSearch,
  TavilyWebSearch,
  WebSearchExtension,
  ZhipuWebSearch,
  webSearchFallbackQuery,
  webSearchNeedsMultipleQueries,
  webSearchQuery,
  webSearchQueryBudget,
  webSearchQueryVariants,
} from "../dist/brain/web-search.js";
import { assignEvidenceGroups } from "../dist/brain/glm.js";
import { TurnRuntime } from "../dist/runtime/turn-runtime.js";
import { summarizeGlmStageArtifact } from "./web-search-stage-artifacts.mjs";
import { resolveWebSearchAcceptanceBudget } from "./web-search-live-budget.mjs";

assert.deepEqual(resolveWebSearchAcceptanceBudget("exa", {}), {
  maxProviderRequests: 487,
  maxGlmRequests: 1264,
  alreadyUsed: { provider: 487, glm: 1264 },
}, "the default live budget cannot spend additional Exa or GLM requests");
assert.deepEqual(resolveWebSearchAcceptanceBudget("exa", {
  WITCH_ACCEPTANCE_MAX_PROVIDER_REQUESTS: "537",
  WITCH_ACCEPTANCE_MAX_GLM_REQUESTS: "1291",
}), {
  maxProviderRequests: 537,
  maxGlmRequests: 1291,
  alreadyUsed: { provider: 487, glm: 1264 },
}, "a future explicitly bounded owner-authorized run can add at most fifty requests");
assert.deepEqual(resolveWebSearchAcceptanceBudget("exa-brave", {
  WITCH_ACCEPTANCE_MAX_PROVIDER_REQUESTS: "537",
  WITCH_ACCEPTANCE_MAX_GLM_REQUESTS: "1291",
}), {
  maxProviderRequests: 537,
  maxGlmRequests: 1291,
  alreadyUsed: { provider: 487, glm: 1264 },
}, "the two-provider acceptance run shares the current Exa/Brave request budget");
assert.deepEqual(resolveWebSearchAcceptanceBudget("exa-brave-tavily", {
  WITCH_ACCEPTANCE_MAX_PROVIDER_REQUESTS: "556",
  WITCH_ACCEPTANCE_MAX_GLM_REQUESTS: "1291",
}), {
  maxProviderRequests: 556,
  maxGlmRequests: 1291,
  alreadyUsed: { provider: 506, glm: 1264 },
}, "three-provider acceptance shares one strict cumulative request cap");
assert.deepEqual(resolveWebSearchAcceptanceBudget("exa-tavily", {
  WITCH_ACCEPTANCE_MAX_PROVIDER_REQUESTS: "556",
}), {
  maxProviderRequests: 556,
  maxGlmRequests: 1264,
  alreadyUsed: { provider: 506, glm: 1264 },
}, "Exa plus Tavily can be tested without requiring a Brave key");
assert.throws(() => resolveWebSearchAcceptanceBudget("exa", {
  WITCH_ACCEPTANCE_MAX_PROVIDER_REQUESTS: "561",
}), /Invalid acceptance budget/u, "an environment override cannot exceed the next bounded Exa ceiling");
assert.throws(() => resolveWebSearchAcceptanceBudget("exa", {
  WITCH_ACCEPTANCE_MAX_GLM_REQUESTS: "1292",
}), /Invalid acceptance budget/u, "an environment override cannot exceed the next bounded GLM ceiling");
assert.throws(() => resolveWebSearchAcceptanceBudget("zhipu", {
  WITCH_ACCEPTANCE_PRIOR_PROVIDER_REQUESTS: "4",
}), /Invalid acceptance budget/u, "a stale provider counter cannot roll back the Zhipu search ledger");
assert.throws(() => resolveWebSearchAcceptanceBudget("brave", {
  WITCH_ACCEPTANCE_MAX_PROVIDER_REQUESTS: "3",
  WITCH_ACCEPTANCE_PRIOR_GLM_REQUESTS: "1098",
}), /Invalid acceptance budget/u, "provider opt-in does not permit rolling back the shared GLM counter");
assert.deepEqual(resolveWebSearchAcceptanceBudget("brave", {
  WITCH_ACCEPTANCE_MAX_PROVIDER_REQUESTS: "3",
}), {
  maxProviderRequests: 3,
  maxGlmRequests: 1264,
  alreadyUsed: { provider: 0, glm: 1264 },
}, "Brave is disabled by default and can only run with a separately explicit finite budget");
assert.deepEqual(resolveWebSearchAcceptanceBudget("tavily", {
  WITCH_ACCEPTANCE_MAX_PROVIDER_REQUESTS: "20",
}), {
  maxProviderRequests: 20,
  maxGlmRequests: 1264,
  alreadyUsed: { provider: 19, glm: 1264 },
}, "Tavily remains disabled by default and has its own low explicit test cap");
assert.deepEqual(resolveWebSearchAcceptanceBudget("baidu", {
  WITCH_ACCEPTANCE_MAX_PROVIDER_REQUESTS: "20",
}), {
  maxProviderRequests: 20,
  maxGlmRequests: 1264,
  alreadyUsed: { provider: 20, glm: 1264 },
}, "Baidu's reconciled calls cannot be replayed as free budget");
assert.deepEqual(resolveWebSearchAcceptanceBudget("exa-tavily-baidu", {
  WITCH_ACCEPTANCE_MAX_PROVIDER_REQUESTS: "560",
}), {
  maxProviderRequests: 560,
  maxGlmRequests: 1264,
  alreadyUsed: { provider: 526, glm: 1264 },
}, "the Exa+Tavily+Baidu acceptance route starts after all reconciled provider calls");

const syndicatedPassage = Array.from({ length: 48 }, (_, index) =>
  `第${index + 1}局记录：棋手通过不同的经营选择积累资源，核心英雄在战斗中获得成长；作者分别说明启动条件、操作顺序和适用对局。`).join("\n");
const nearDuplicateGroups = assignEvidenceGroups([
  { title: "攻略原文", link: "https://guide.example/original", content: syndicatedPassage },
  { title: "转载改版", link: "https://news.example/repost", content: `编辑导语：本文整理了玩家经验。\n${syndicatedPassage}\n页面导航与相关推荐` },
  { title: "同题独立经验", link: "https://community.example/independent", content: Array.from({ length: 48 }, (_, index) =>
    `第${index + 1}场复盘：观察敌方阵线后调整布阵节奏，优先保护后排并根据资源情况改变刷新目标；作者给出另一套独立操作建议。`).join("\n") },
]);
assert.equal(nearDuplicateGroups.get(1), nearDuplicateGroups.get(2),
  "a copied long passage remains one evidence group even when another site adds editorial framing");
assert.notEqual(nearDuplicateGroups.get(1), nearDuplicateGroups.get(3),
  "independently written evidence about the same topic is not collapsed by shared subject matter");

const summarizedAudit = summarizeGlmStageArtifact({ stage: "answerAudit", httpStatus: 200, elapsedMs: 31,
  payload: { choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ approved: false,
    rejectedClaims: [2], rejectedLimitations: [], issues: ["版本未说明"], secret: "must not persist" }),
    reasoning_content: "private reasoning must not persist" } }] } });
assert.deepEqual(summarizedAudit.output, { approved: false, rejectedClaims: [2], rejectedLimitations: [], issues: ["版本未说明"] },
  "live acceptance stores only the allowlisted audit outcome, not arbitrary model output or reasoning");
assert.equal(JSON.stringify(summarizedAudit).includes("must not persist"), false);
const summarizedReviewHandoff = summarizeGlmStageArtifact({ stage: "synthesis", httpStatus: 200, elapsedMs: 25,
  requestBody: { messages: [
    { role: "system", content: "complete user prompt must not persist" },
    { role: "tool", content: JSON.stringify({ evidenceReview: { reviewerNotes: [
      { sourceIds: [7], requestedPointIds: [1, 3], riskType: "temporal", note: "来源日期早于作品上线，不能支持当前版本结论。", secret: "omit" },
    ], independenceAssessments: [
      { requestedPointId: 3, sourceIds: [5, 9], status: "uncertain", rationale: "不同域名，但无法排除转载或共用原稿。", secret: "omit" },
    ] } }) },
  ] },
  payload: { choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ claims: [], limitations: [] }) } }] } });
assert.deepEqual(summarizedReviewHandoff.input, { reviewerNotes: [
  { sourceIds: [7], requestedPointIds: [1, 3], riskType: "temporal", note: "来源日期早于作品上线，不能支持当前版本结论。" },
] , evidenceCoverage: {
  gaps: [], pages: [], independenceAssessments: [
    { requestedPointId: 3, sourceIds: [5, 9], status: "uncertain", rationale: "不同域名，但无法排除转载或共用原稿。" },
  ],
} }, "live acceptance records source relationship uncertainty that reaches synthesis");
assert.equal(JSON.stringify(summarizedReviewHandoff).includes("complete user prompt"), false,
  "review-handoff evidence does not persist prompts or arbitrary note metadata");
const summarizedFailedAudit = summarizeGlmStageArtifact({ stage: "answerAudit", elapsedMs: 180_000,
  requestBody: { messages: [{ role: "user", content: JSON.stringify({ evidenceReviewCards: {
    reviewerNotes: [{ sourceIds: [2], requestedPointIds: [2], riskType: "version", note: "版本未核实，不能据此断言当前有效。" }],
  } }) }] },
  error: new DOMException("The operation was aborted due to timeout", "TimeoutError") });
assert.deepEqual(summarizedFailedAudit.input, { reviewerNotes: [
  { sourceIds: [2], requestedPointIds: [2], riskType: "version", note: "版本未核实，不能据此断言当前有效。" },
] }, "failed/timed-out stages still record which bounded reviewer notes reached the request");
assert.equal(summarizedFailedAudit.output, undefined);
const summarizedRelevance = summarizeGlmStageArtifact({ stage: "answerRelevance", httpStatus: 200, elapsedMs: 21,
  payload: { choices: [{ message: { content: JSON.stringify({ approved: false,
    rejectedClaims: [1], rejectedLimitations: [], issues: ["旁支日期不相关"], secret: "omit" }) } }] } });
assert.deepEqual(summarizedRelevance.output, { approved: false, rejectedClaims: [1], rejectedLimitations: [], issues: ["旁支日期不相关"] },
  "live artifacts retain the separate relevance gate result without arbitrary model fields");
const summarizedEvidence = summarizeGlmStageArtifact({ stage: "evidenceReview", httpStatus: 200, elapsedMs: 42,
  requestBody: { messages: [{ role: "user", content: JSON.stringify({ sources: [
    { sourceId: 1, evidenceGroupId: 7, title: "官方页面", url: "https://example.com/official", sourceKind: "first-party", published: "2026-01-01", author: "发布方", content: "must not persist" },
    { sourceId: 3, evidenceGroupId: 8, title: "媒体页面", url: "https://example.org/report", sourceKind: "media", published: "2026-01-02", content: "private page text" },
  ] }) }] },
  payload: { choices: [{ message: { content: JSON.stringify({ cards: [{ point: "机制", finding: "触发条件", status: "supported",
    quotes: [{ sourceId: 3, quote: "逐字原文" }] }], gaps: [{ requestedPointIds: [2], sourceIds: [3], text: "正文缺少某细节" }],
    independenceAssessments: [{ requestedPointId: 2, sourceIds: [3, 4], status: "uncertain", rationale: "不同域名但转载关系未明。" }],
    followupQueries: [], sourceDisclosures: [], unlisted: true }) } }] } });
assert.equal(summarizedEvidence.output.cards[0].quotes[0].sourceId, 3);
assert.deepEqual(summarizedEvidence.input.evidenceSourceMap, [
  { sourceId: 1, evidenceGroupId: 7, title: "官方页面", link: "https://example.com/official", publishDate: "2026-01-01", author: "发布方", sourceKind: "first-party" },
  { sourceId: 3, evidenceGroupId: 8, title: "媒体页面", link: "https://example.org/report", publishDate: "2026-01-02", author: "", sourceKind: "media" },
], "evidence stage summaries preserve exact source IDs and safe citation metadata without page text");
assert.equal(JSON.stringify(summarizedEvidence).includes("must not persist"), false);
assert.equal(JSON.stringify(summarizedEvidence).includes("private page text"), false);
assert.deepEqual(summarizedEvidence.output.gaps, [{ requestedPointIds: [2], sourceIds: [3], text: "正文缺少某细节" }],
  "evidence reports retain source-bound gap metadata without retaining arbitrary model fields");
assert.deepEqual(summarizedEvidence.output.independenceAssessments, [
  { requestedPointId: 2, sourceIds: [3, 4], status: "uncertain", rationale: "不同域名但转载关系未明。" },
], "live artifacts preserve typed source-relationship reviews without arbitrary model fields");
assert.equal(JSON.stringify(summarizedEvidence).includes("unlisted"), false,
  "stage artifact summaries exclude fields outside the explicit review schema");
const summarizedCoverage = summarizeGlmStageArtifact({ stage: "answerAudit", httpStatus: 200, elapsedMs: 12,
  requestBody: { messages: [{ role: "user", content: JSON.stringify({
    evidenceGaps: [{ requestedPointIds: [2], sourceIds: [3], text: "正文是否覆盖技能" }],
    sourceCoveragePages: [{ sourceId: 3, text: "secret full public page text" }],
  }) }] },
  payload: { choices: [{ message: { content: JSON.stringify({ approved: true, rejectedClaims: [], rejectedLimitations: [], issues: [] }) } }] } });
assert.deepEqual(summarizedCoverage.input.evidenceCoverage, {
  gaps: [{ requestedPointIds: [2], sourceIds: [3] }], pages: [{ sourceId: 3, characters: 28 }],
}, "stage artifacts record which full pages were checked and their lengths, but never persist page bodies");
assert.equal(JSON.stringify(summarizedCoverage).includes("secret full public page text"), false,
  "full page content is not written into stage artifacts");
const summarizedPlan = summarizeGlmStageArtifact({ stage: "planner", httpStatus: 200, elapsedMs: 9,
  payload: { choices: [{ message: { content: JSON.stringify({ needsSearch: true,
    queries: ["作品 核心玩法"], answerPoints: ["核心玩法"], responseConstraints: ["不混入相似游戏"], privateField: "omit" }) } }] } });
assert.equal(summarizedPlan.output.needsSearch, true);
assert.deepEqual(summarizedPlan.output.queries, ["作品 核心玩法"]);
assert.deepEqual(summarizedPlan.output.answerPoints, ["核心玩法"]);
assert.deepEqual(summarizedPlan.output.responseConstraints, ["不混入相似游戏"]);
assert.equal(JSON.stringify(summarizedPlan).includes("privateField"), false,
  "planner JSON outputs are retained through their typed fields rather than treated as function calls");

function withWebSearch(inner, search, planner) {
  return new TurnRuntime(inner, [new WebSearchExtension(search, planner)]);
}

assert.equal(
  webSearchQuery("查一下 DeepSeek V4 flash 的价格和能力"),
  "DeepSeek V4 flash 的价格和能力",
  "a natural request for model information should search",
);
assert.equal(
  webSearchQuery("查一下deepseek v4 flash的api价格 单任务成本和模型能力"),
  "deepseek v4 flash的api价格 单任务成本和模型能力",
  "a lookup request without a space after the verb should search",
);
assert.equal(
  webSearchQuery("好 查一下deepseek v4 flash的价格和能力"),
  "deepseek v4 flash的价格和能力",
  "a conversational acknowledgement before a lookup command should still search",
);
assert.equal(
  webSearchQuery("最近新出的游戏 星痕共鸣 细节怎么样"),
  "最近新出的游戏 星痕共鸣 细节怎么样",
  "a recent game detail question should search without an explicit verb",
);
assert.equal(
  webSearchQuery("看看这个游戏的角色和玩法"),
  "这个游戏的角色和玩法",
  "an implicit game detail request should search",
);
assert.equal(
  webSearchQuery("王者荣耀万象棋 白歌的三分倒转阵营该怎么玩"),
  "王者荣耀万象棋 白歌的三分倒转阵营该怎么玩",
  "a niche strategy request should search even when the game mode name is not generic",
);
assert.equal(
  webSearchQuery("我最近在玩游戏"),
  undefined,
  "ordinary conversation mentioning a recent game should not search",
);
assert.equal(
  webSearchQuery("今天北京天气怎么样"),
  "今天北京天气怎么样",
  "a live weather question should search",
);
assert.equal(
  webSearchQuery("联网搜索：智谱 GLM 最新模型"),
  "智谱 GLM 最新模型",
  "the original explicit command should keep working",
);
assert.equal(
  webSearchQuery("你今天心情怎么样"),
  undefined,
  "ordinary chat must not be sent to search",
);
assert.equal(
  webSearchQuery("我觉得本地模型的上下文还是不太够"),
  undefined,
  "an opinion without a lookup request must not search",
);
assert.equal(
  webSearchQuery("不要联网，查一下最新价格"),
  undefined,
  "an explicit opt-out must win",
);
assert.equal(
  webSearchFallbackQuery("deepseek v4 flash的api价格 单任务成本和模型能力"),
  "DeepSeek v4 flash 官方",
  "an empty result should retry with the normalized core subject and official-source hint",
);
assert.equal(webSearchFallbackQuery("DeepSeek 官方价格"), undefined, "already-official queries should not loop");
assert.deepEqual(
  webSearchQueryVariants("deepseek v4 flash的api价格 单任务成本和模型能力"),
  [
    "deepseek v4 flash的api价格 单任务成本和模型能力",
    "DeepSeek v4 flash 官方",
    "DeepSeek v4 flash API",
  ],
  "model/API lookups should have at most three ordered variants",
);
assert.deepEqual(
  webSearchQueryVariants("今天北京天气怎么样"),
  ["今天北京天气怎么样", "今天北京天气怎么样 官方"],
  "weather should use the official fallback but not an API variant",
);
assert.equal(
  webSearchNeedsMultipleQueries("最近新出的游戏 星痕共鸣 细节怎么样"),
  true,
  "detailed game research should use a focused second query",
);
assert.equal(
  webSearchQueryBudget("王者荣耀万象棋 白歌的三分倒转阵营该怎么玩"),
  3,
  "strategy games should use three research passes",
);
assert.equal(
  webSearchQuery("来测试一下你的联网搜索能力，查一下王者荣耀万象奇白歌皮肤祈愿的活动详情。"),
  "王者荣耀万象奇白歌皮肤祈愿的活动详情。",
  "meta-conversation before an embedded lookup command should not pollute the query",
);
assert.equal(
  webSearchQuery("再测试一下你的能力，来吧，去查一下我刚才说的活动。"),
  "我刚才说的活动。",
  "a colloquial 'go look it up' command should extract only its topic",
);
assert.equal(
  webSearchQuery("不，现在给你更新了，用你自己的联网能力查一下我刚才说的活动。"),
  "我刚才说的活动。",
  "a lookup verb attached to meta-conversation should still extract its topic",
);
assert.deepEqual(
  webSearchQueryVariants("最近新出的游戏 星痕共鸣 细节怎么样"),
  [
    "最近新出的游戏 星痕共鸣 细节怎么样",
    "最近新出的游戏 星痕共鸣 玩法 角色 版本 详细资料",
    "最近新出的游戏 星痕共鸣 官方",
  ],
  "detailed game research should add a focused query before the official fallback",
);
assert.deepEqual(
  webSearchQueryVariants("王者荣耀万象棋 白歌的三分倒转阵营该怎么玩"),
  [
    "王者荣耀万象棋 白歌的三分倒转阵营该怎么玩",
    "王者荣耀万象棋 白歌的三分倒转 阵容 运营 核心机制 前期",
    "王者荣耀万象棋 白歌的三分倒转 前期运营 中期成型 装备 天赋",
    "王者荣耀万象棋 白歌的三分倒转 官方",
  ],
  "niche strategy research should add a game-specific operations query",
);

const queries = [];
const forwarded = [];
const retrySearch = {
  async search(query) {
    queries.push(query);
    return queries.length === 1 ? [] : [{ title: "官方价格页", link: "", content: "价格" }];
  },
};
const retryBrain = withWebSearch({
  async reply(request) {
    forwarded.push(request);
    return { provider: "mock", text: "有来源" };
  },
}, retrySearch);
const retryResult = await retryBrain.reply({
  conversationId: "test:private:1",
  text: "查一下deepseek v4 flash的api价格 单任务成本和模型能力",
  attachments: [],
});
assert.equal(retryResult.text, "有来源");
assert.deepEqual(queries, ["deepseek v4 flash的api价格 单任务成本和模型能力", "DeepSeek v4 flash 官方"]);
assert.deepEqual(forwarded[0].webSearchQueries, queries);

const detailQueries = [];
const detailForwarded = [];
const detailSearch = {
  async search(query) {
    detailQueries.push(query);
    return [{ title: query, link: "https://example.test/" + detailQueries.length, content: "摘要 " + detailQueries.length }];
  },
};
const detailBrain = withWebSearch({
  async reply(request) {
    detailForwarded.push(request);
    return { provider: "mock", text: "详细来源" };
  },
}, detailSearch);
const detailResult = await detailBrain.reply({
  conversationId: "test:private:detail",
  text: "最近新出的游戏 星痕共鸣 细节怎么样",
  attachments: [],
});
assert.equal(detailResult.text, "详细来源");
assert.equal(detailQueries.length, 2, "detailed topics should use two focused search queries");
assert.equal(detailForwarded[0].webSearchResults.length, 2, "results from both focused queries should be forwarded");

const strategyQueries = [];
const strategyForwarded = [];
const strategySearch = {
  async search(query) {
    strategyQueries.push(query);
    return [{ title: query, link: "https://example.test/strategy/" + strategyQueries.length, content: "策略摘要 " + strategyQueries.length }];
  },
};
const strategyBrain = withWebSearch({
  async reply(request) {
    strategyForwarded.push(request);
    return { provider: "mock", text: "策略来源" };
  },
}, strategySearch);
const strategyResult = await strategyBrain.reply({
  conversationId: "test:private:strategy",
  text: "王者荣耀万象棋 白歌的三分倒转阵营该怎么玩",
  attachments: [],
});
assert.equal(strategyResult.text, "策略来源");
assert.equal(strategyQueries.length, 3, "strategy games should use three focused search queries");
assert.equal(strategyForwarded[0].webSearchResults.length, 3, "all strategy passes should be forwarded");

const contextualQueries = [];
const plannerCalls = [];
const contextualBrain = withWebSearch({
  async reply(request) {
    return { provider: "mock", text: request.webSearchResults?.[0]?.content ?? "missing" };
  },
}, {
  async search(query) {
    contextualQueries.push(query);
    return [{ title: "活动", link: "https://example.test/context", content: "已恢复上下文查询" }];
  },
}, {
  async planWebSearchQuery(request, extractedQuery) {
    plannerCalls.push({ request, extractedQuery });
    return "王者万象棋 白歌 墨世龙尘 祈愿活动";
  },
});
const contextualResult = await contextualBrain.reply({
  conversationId: "test:private:context",
  text: "我的意思是动用你自己的联网能力。",
  attachments: [],
  history: [
    { role: "user", source: "qq", text: "去查一下王者万象棋白歌皮肤祈愿活动", timestamp: "2026-09-16T00:00:00.000Z" },
    { role: "assistant", source: "witch", text: "是否请 Codex 老师？", timestamp: "2026-09-16T00:00:01.000Z" },
    { role: "user", source: "qq", text: "不对", timestamp: "2026-09-16T00:00:02.000Z" },
  ],
});
assert.equal(contextualResult.text, "已恢复上下文查询");
assert.deepEqual(contextualQueries, [
  "王者万象棋 白歌 墨世龙尘 祈愿活动",
  "王者万象棋 白歌 墨世龙尘 祈愿活动 玩法 角色 版本 详细资料",
]);
assert.equal(plannerCalls.length, 1);

const visualQueries = [];
const visualPlannerCalls = [];
const visualBrain = withWebSearch({
  async reply(request) {
    assert.equal(request.attachments.length, 1);
    assert.ok(request.webSearchResults?.length >= 1);
    return { provider: "mock", text: "已结合图片和网页复核" };
  },
}, {
  async search(query) {
    visualQueries.push(query);
    return [{ title: query, link: `https://example.test/visual/${visualQueries.length}`, content: "角色资料" }];
  },
}, {
  async planWebSearchQuery() { return undefined; },
  async planImageWebSearchQuery(request) {
    visualPlannerCalls.push(request);
    return "王者万象棋 胜利结算 白发角色 识别";
  },
});
const visualResult = await visualBrain.reply({
  conversationId: "test:private:visual",
  text: "",
  attachments: [{ kind: "image", mimeType: "image/jpeg", localPath: "C:/temp/game.jpg" }],
});
assert.equal(visualResult.text, "已结合图片和网页复核");
assert.equal(visualPlannerCalls.length, 1);
assert.equal(visualQueries[0], "王者万象棋 胜利结算 白发角色 识别");
assert.equal(visualQueries.length, 3, "visual identification should use atlas and official corroboration queries");
assert.match(visualQueries[1], /棋手图鉴 角色立绘/);
assert.match(visualQueries[2], /官方角色介绍/);
assert.equal(visualQueries.some((query) => /前期运营|装备 天赋/.test(query)), false);

let casualSearches = 0;
const casualBrain = withWebSearch({
  async reply(request) {
    assert.equal(request.webSearchResults, undefined);
    return { provider: "mock", text: "普通看图聊天" };
  },
}, {
  async search() {
    casualSearches += 1;
    return [];
  },
}, {
  async planWebSearchQuery() { return undefined; },
  async planImageWebSearchQuery() { return undefined; },
});
const casualResult = await casualBrain.reply({
  conversationId: "test:private:cat",
  text: "",
  attachments: [{ kind: "image", mimeType: "image/jpeg", localPath: "C:/temp/cat.jpg" }],
});
assert.equal(casualResult.text, "普通看图聊天");
assert.equal(casualSearches, 0, "casual images should not trigger web search");

const originalFetch = globalThis.fetch;
const exaCalls = [];
globalThis.fetch = async (url, init) => {
  exaCalls.push({ url, init, body: JSON.parse(init.body) });
  if (String(url).endsWith("/contents")) {
    return new Response(JSON.stringify({ requestId: "exa-contents-smoke-1", costDollars: { total: 0.006 }, results: [
      { title: "活动说明正文", url: "https://game.example/notice", publishedDate: "2026-10-01", author: "运营团队",
        text: "完整公告正文：活动于 2026 年 10 月 1 日开启。".repeat(300),
        highlights: ["补充背景：活动面向全体玩家。", "公告原文：活动于 2026 年 10 月 1 日开启。"],
        highlightScores: [0.2, 0.9] },
    ] }), { status: 200 });
  }
  return new Response(JSON.stringify({
    requestId: "exa-smoke-1",
    results: [
      { title: "活动说明", url: "https://game.example/notice", publishedDate: "2026-10-01", author: "运营团队",
        text: "整页正文不应优先送审。".repeat(500),
        highlights: ["补充背景：活动面向全体玩家。", "公告原文：活动于 2026 年 10 月 1 日开启。"],
        highlightScores: [0.2, 0.9] },
      { title: "不安全来源", url: "http://127.0.0.1/private", highlights: ["不能成为引用链接", "分数缺项时保留原序"],
        highlightScores: [0.8] },
      { title: "仅生成摘要", url: "https://game.example/summary", summary: "生成摘要不能作为原文引证。" },
    ],
  }), { status: 200 });
};
const exa = new ExaWebSearch({ apiKey: "exa-test-key", timeoutMs: 1_000, count: 99, maxCharactersPerResult: 9000 });
const exaResults = await exa.searchWithFallback("游戏活动具体规则", new AbortController().signal, {
  requestedPoints: [{ id: 1, text: "活动具体开启日期" }, { id: 2, text: "活动参与条件" }],
  responseConstraints: ["区分游戏官方公告与玩家攻略"],
});
assert.equal(exaCalls.length, 1, "Exa provider makes exactly one search request per tool call");
assert.equal(exaCalls[0].url, "https://api.exa.ai/search");
assert.equal(exaCalls[0].init.headers["x-api-key"], "exa-test-key");
assert.equal(exaCalls[0].body.type, "auto");
assert.match(exaCalls[0].body.objective, /Prefer primary publisher or official documentation/u,
  "the Exa retrieval objective prioritizes primary sources for official facts without excluding strategy guides");
assert.match(exaCalls[0].body.objective, /Preserve source disagreement and version scope/u,
  "the retrieval objective keeps source variants and version scope distinct");
assert.match(exaCalls[0].body.objective, /活动具体开启日期/u,
  "Exa receives the audited answer points as task context, not only an isolated query string");
assert.match(exaCalls[0].body.objective, /区分游戏官方公告与玩家攻略/u,
  "source/reporting constraints are passed as task guidance rather than appended to the search query");
assert.doesNotMatch(exaCalls[0].body.objective, /recentContext|QQ 私聊/u,
  "search task context has no conversation-history field");
assert.ok(exaCalls[0].body.objective.length <= 4096,
  "provider objective remains inside Exa's documented size limit");
assert.equal(exaCalls[0].body.numResults, 10, "provider result count is hard-capped at ten");
assert.deepEqual(exaCalls[0].body.contents.highlights, { query: "游戏活动具体规则", maxCharacters: 3000 },
  "Exa is asked for query-specific highlights rather than full page bodies");
assert.equal(exaResults.length, 2, "generated summaries are not admitted as quote-verifiable source passages");
assert.equal(exaResults[0].link, "https://game.example/notice");
assert.equal(exaResults[0].content, "公告原文：活动于 2026 年 10 月 1 日开启。\n补充背景：活动面向全体玩家。",
  "complete Exa highlight similarity scores order passages without discarding lower-scored evidence");
assert.equal(exaResults[0].author, "运营团队");
assert.equal(exaResults[1].link, "", "non-HTTPS/private citation targets are not exposed");
assert.equal(exaResults[1].content, "不能成为引用链接\n分数缺项时保留原序",
  "missing or misaligned highlight scores preserve the provider's original passage order");
const enrichedExaResults = await exa.enrichResults(exaResults, new AbortController().signal);
assert.equal(exaCalls.length, 2, "Exa fetches discovered pages in one separate bounded contents request");
assert.equal(exaCalls[1].url, "https://api.exa.ai/contents");
assert.deepEqual(exaCalls[1].body.urls, ["https://game.example/notice"], "only public discovered URLs are sent for page retrieval");
assert.equal(exaCalls[1].body.text.maxCharacters, 12000, "page text is capped for local verification");
assert.equal(exaCalls[1].body.highlights, undefined,
  "Contents must not regenerate one shared-query highlight set for results from several queries");
assert.equal(enrichedExaResults[0].content, "公告原文：活动于 2026 年 10 月 1 日开启。\n补充背景：活动面向全体玩家。",
  "local full-page retrieval preserves each search result's original query-specific excerpt");
assert.match(enrichedExaResults[0].verificationContent, /完整公告正文/);
assert.equal(enrichedExaResults[0].fullPageFetched, true);

const providerCalls = [];
globalThis.fetch = async (_url, init) => {
  const body = JSON.parse(init.body);
  providerCalls.push(body);
  if (body.search_engine === "search_pro") {
    return new Response(JSON.stringify({ search_result: [] }), { status: 200 });
  }
  return new Response(JSON.stringify({
    search_result: [{ title: "夸克结果", link: "https://example.test/quark", content: "高细节摘要" }],
  }), { status: 200 });
};
const provider = new ZhipuWebSearch({
  apiKey: "test-key",
  baseUrl: "https://example.test",
  timeoutMs: 1_000,
  engines: ["search_pro", "search_pro_quark"],
  count: 10,
  contentSize: "high",
});
const providerResults = await provider.searchWithFallback("最近新出的游戏细节");
assert.equal(providerResults[0].title, "夸克结果");
assert.deepEqual(providerCalls.map((call) => call.search_engine), ["search_pro", "search_pro_quark"]);
assert.equal(providerCalls[0].count, 10);
assert.equal(providerCalls[0].content_size, "high");

const braveCalls = [];
globalThis.fetch = async (url, init) => {
  braveCalls.push({ url: String(url), init, body: JSON.parse(init.body) });
  return new Response(JSON.stringify({
    grounding: { generic: [
      { url: "https://publisher.example/rule", title: "官方规则页", snippets: ["规则原文第一段", "规则原文第二段"] },
      { url: "javascript:alert(1)", title: "不安全引用", snippets: ["仍不可作为安全链接"] },
      { url: "https://publisher.example/empty", title: "没有摘录", snippets: [] },
    ] },
    sources: { "https://publisher.example/rule": { site_name: "Publisher Example" } },
  }), { status: 200 });
};
const brave = new BraveLlmContextSearch({ apiKey: "brave-test-key", baseUrl: "https://example.test/context", timeoutMs: 1_000 });
const braveResults = await brave.searchWithFallback("游戏规则具体机制");
assert.equal(braveCalls.length, 1, "Brave LLM Context performs one bounded search request per query");
assert.equal(braveCalls[0].url, "https://example.test/context");
assert.equal(braveCalls[0].init.headers["x-subscription-token"], "brave-test-key");
assert.deepEqual(braveCalls[0].body, {
  q: "游戏规则具体机制",
  country: "CN",
  search_lang: "zh-hans",
  count: 10,
  maximum_number_of_urls: 10,
  maximum_number_of_tokens: 8192,
  maximum_number_of_tokens_per_url: 2048,
  context_threshold_mode: "balanced",
  enable_source_metadata: true,
});
assert.equal(braveResults.length, 2, "Brave results without text are ignored while unsafe URLs are never exposed");
assert.equal(braveResults[0].link, "https://publisher.example/rule");
assert.equal(braveResults[0].content, "规则原文第一段\n\n规则原文第二段");
assert.equal(braveResults[0].media, "Publisher Example");
assert.equal(braveResults[1].link, "", "untrusted Brave citation URL fails closed");

const tavilyCalls = [];
globalThis.fetch = async (url, init) => {
  tavilyCalls.push({ url: String(url), init, body: JSON.parse(init.body) });
  return new Response(JSON.stringify({
    usage: { credits: 1 },
    results: [
      { title: "Tavily 页面", url: "https://publisher.example/tavily", content: "Tavily source passage", published_date: "2026-10-01" },
      { title: "Unsafe", url: "http://insecure.example/page", content: "Do not cite" },
    ],
  }), { status: 200 });
};
const tavily = new TavilyWebSearch({ apiKey: "tavily-test-key", timeoutMs: 1_000, count: 5 });
const tavilyResults = await tavily.searchWithFallback("游戏规则具体机制");
assert.equal(tavilyCalls.length, 1);
assert.equal(tavilyCalls[0].url, "https://api.tavily.com/search");
assert.equal(tavilyCalls[0].init.headers.authorization, "Bearer tavily-test-key");
assert.deepEqual(tavilyCalls[0].body, {
  query: "游戏规则具体机制", search_depth: "basic", max_results: 5, chunks_per_source: 3,
  include_answer: false, include_raw_content: false, include_usage: true,
  country: "china", language: "zh",
});
assert.deepEqual(tavilyResults, [{
  title: "Tavily 页面", link: "https://publisher.example/tavily", content: "Tavily source passage",
  publishDate: "2026-10-01", searchProviders: ["tavily"],
}], "Tavily contributes only safe source-linked snippets, never its generated answer or raw page text");
const tavilyFetch = globalThis.fetch;

const baiduCalls = [];
globalThis.fetch = async (url, init) => {
  baiduCalls.push({ url: String(url), init, body: JSON.parse(init.body) });
  return new Response(JSON.stringify({ request_id: "baidu-smoke-1", references: [
    { type: "web", title: "百度网页结果", url: "https://publisher.example/baidu", content: "搜索结果摘录", website: "示例来源", date: "2026-10-01", authority_score: 0.99 },
    { type: "web", title: "不安全 HTTP 链接", url: "http://publisher.example/insecure", content: "不应进入证据链" },
    { type: "video", title: "视频结果", url: "https://publisher.example/video", content: "当前只接受网页" },
    { type: "web", title: "重复链接", url: "https://publisher.example/baidu", content: "应去重" },
  ] }), { status: 200 });
};
const baidu = new BaiduWebSearch({ apiKey: "baidu-test-key", timeoutMs: 1_000, count: 10 });
const baiduResults = await baidu.searchWithFallback("公开游戏规则的具体机制");
assert.equal(baiduCalls.length, 1, "Baidu performs one bounded search request per query");
assert.equal(baiduCalls[0].url, "https://qianfan.baidubce.com/v2/ai_search/web_search");
assert.equal(baiduCalls[0].init.headers["X-Appbuilder-Authorization"], "Bearer baidu-test-key");
assert.deepEqual(baiduCalls[0].body, {
  messages: [{ role: "user", content: "公开游戏规则的具体机制" }],
  search_source: "baidu_search_v2",
  resource_type_filter: [{ type: "web", top_k: 10 }],
});
assert.deepEqual(baiduResults, [{
  title: "百度网页结果", link: "https://publisher.example/baidu", content: "搜索结果摘录",
  media: "示例来源", publishDate: "2026-10-01", searchProviders: ["baidu"],
}], "Baidu contributes only unique safe web references; generated answers, non-web hits, and unsafe URLs are excluded");

globalThis.fetch = async () => new Response(JSON.stringify({ code: 216003, message: "authentication failed", references: [] }), { status: 401 });
await assert.rejects(() => baidu.searchWithFallback("公开测试"), /Baidu Search failed \(authentication failed\)/u,
  "Baidu authentication errors fail explicitly without leaking request credentials");
globalThis.fetch = tavilyFetch;

const compositeCalls = [];
const composite = new ExaBraveWebSearch({
  async searchWithFallback(query, signal, context) {
    compositeCalls.push({ provider: "exa", query, signal, context });
    return [
      { title: "同一来源", link: "https://publisher.example/shared", content: "Exa excerpt", searchProviders: ["exa"] },
      { title: "Exa 独有", link: "https://exa.example/only", content: "Exa only", searchProviders: ["exa"] },
    ];
  },
  async enrichResults(results) {
    compositeCalls.push({ provider: "contents", links: results.map((item) => item.link) });
    return results;
  },
}, {
  async searchWithFallback(query, signal) {
    compositeCalls.push({ provider: "brave", query, signal });
    return [
      { title: "同一来源重复", link: "https://publisher.example/shared", content: "Brave excerpt", searchProviders: ["brave"] },
      { title: "Brave 独有", link: "https://brave.example/only", content: "Brave only", searchProviders: ["brave"] },
      { title: "不安全链接", link: "", content: "must be dropped", searchProviders: ["brave"] },
    ];
  },
}, {
  async searchWithFallback(query, signal) {
    compositeCalls.push({ provider: "tavily", query, signal });
    return [{ title: "Tavily 独有", link: "https://tavily.example/only", content: "Tavily only" }];
  },
});
const compositeContext = { requestedPoints: [{ id: 1, text: "官方规则" }], responseConstraints: ["媒体和官方分开"] };
const compositeResults = await composite.searchWithFallback("作品规则", new AbortController().signal, compositeContext);
assert.deepEqual(compositeCalls.slice(0, 3).map((call) => call.provider), ["exa", "brave", "tavily"],
  "all three configured indexes are queried concurrently for the same focused model-authored query");
assert.deepEqual(compositeCalls[0].context, compositeContext,
  "the structured evidence task context reaches Exa without forwarding conversation history");
assert.deepEqual(compositeResults.map((item) => item.title), ["同一来源", "Tavily 独有", "Exa 独有", "Brave 独有"],
  "ranked provider queues are interleaved, canonical URL duplicates are merged, and unsafe targets are excluded");
assert.deepEqual(compositeResults[0].searchProviders, ["exa", "brave"],
  "deduplicated evidence retains independent provider provenance");
assert.deepEqual(compositeResults[0].searchExcerpts.map((item) => item.provider), ["exa", "brave"],
  "deduplicated passages retain per-provider excerpt provenance");
assert.deepEqual(compositeResults[0].searchRanks?.map((item) => [item.provider, item.rank]), [["exa", 1], ["brave", 1]],
  "each deduplicated candidate retains its original rank from every provider list for later RRF");
await composite.enrichResults(compositeResults, new AbortController().signal);
assert.equal(compositeCalls.at(-1).provider, "contents",
  "full-page verification remains delegated to Exa after cross-index candidate selection");

const exaTavily = new ExaBraveWebSearch({
  async searchWithFallback() { return [{ title: "Exa", link: "https://exa.example/result", content: "exa" }]; },
  async enrichResults(results) { return results; },
}, new TavilyWebSearch({ apiKey: "mock", timeoutMs: 1_000 }));
const exaTavilyResults = await exaTavily.searchWithFallback("query");
assert.deepEqual(exaTavilyResults.map((item) => item.searchProviders?.[0]), ["exa", "tavily"],
  "Exa+Tavily can run as a two-index route without a Brave credential");

const baiduForComposite = new BaiduWebSearch({ apiKey: "mock", timeoutMs: 1_000 });
baiduForComposite.searchWithFallback = async () => [{
  title: "百度独有", link: "https://baidu.example/result", content: "baidu",
}];
const exaTavilyBaidu = new ExaBraveWebSearch({
  async searchWithFallback() { return [{ title: "Exa", link: "https://exa.example/result", content: "exa" }]; },
  async enrichResults(results) { return results; },
}, new TavilyWebSearch({ apiKey: "mock", timeoutMs: 1_000 }), baiduForComposite);
const exaTavilyBaiduResults = await exaTavilyBaidu.searchWithFallback("query");
assert.deepEqual(exaTavilyBaiduResults.map((item) => item.searchProviders?.[0]), ["exa", "tavily", "baidu"],
  "Exa+Tavily+Baidu retains provenance from three independently configured indexes");

const partialComposite = new ExaBraveWebSearch({
  async searchWithFallback() { throw new Error("Exa temporarily unavailable"); },
}, {
  async searchWithFallback() { return [{ title: "Brave result", link: "https://brave.example/result", content: "usable evidence" }]; },
});
assert.equal((await partialComposite.searchWithFallback("query")).length, 1,
  "one provider outage must not discard the independent provider's usable results");
const failedComposite = new ExaBraveWebSearch({
  async searchWithFallback() { throw new Error("Exa unavailable"); },
}, {
  async searchWithFallback() { throw new Error("Brave unavailable"); },
});
await assert.rejects(() => failedComposite.searchWithFallback("query"), /All configured web search providers failed/u,
  "when both independent indexes fail, the composite reports total failure instead of fake empty evidence");
globalThis.fetch = originalFetch;

console.log("web search smoke: ok");
