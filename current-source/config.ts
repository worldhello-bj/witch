import "dotenv/config";
import path from "node:path";
import type { BrainProvider } from "./types.js";
import type { SearchContentSize, SearchEngine } from "./brain/web-search.js";

export type CodexTransport = "sdk" | "queue";
export type CodexRouting = "single" | "auto";

function csv(value: string | undefined): Set<string> {
  return new Set(
    (value ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
  );
}

export interface Config {
  onebotWsUrl: string;
  allowFrom: Set<string>;
  outboundTo?: string;
  controlPort: number;
  brainProvider: BrainProvider;
  codexTransport: CodexTransport;
  codexRouting: CodexRouting;
  codexVisibleThreadId?: string;
  codexReplyTimeoutMs: number;
  personalityFile: string;
  memoryFile: string;
  runtimeDir: string;
  projectsRoot: string;
  glmApiKey?: string;
  glmBaseUrl: string;
  glmModel: string;
  glmReasoningEffort: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  glmMaxTokens: number;
  glmTimeoutMs: number;
  glmWebSearchTimeoutMs: number;
  glmWebSearchTurnTimeoutMs: number;
  glmWebSearchEnabled: boolean;
  glmWebSearchProvider: "exa" | "zhipu" | "brave" | "tavily" | "baidu" | "exa-brave" | "exa-tavily" | "exa-brave-tavily" | "exa-tavily-baidu";
  exaApiKey?: string;
  braveSearchApiKey?: string;
  tavilyApiKey?: string;
  baiduAppBuilderApiKey?: string;
  braveSearchTimeoutMs: number;
  tavilySearchTimeoutMs: number;
  baiduSearchTimeoutMs: number;
  baiduSearchCount: number;
  exaTimeoutMs: number;
  exaCount: number;
  exaMaxCharactersPerResult: number;
  glmWebSearchEngines: SearchEngine[];
  glmWebSearchCount: number;
  glmWebSearchContentSize: SearchContentSize;
  codexTeacherEnabled: boolean;
  codexTeacherSkillFile: string;
}

export function loadConfig(): Config {
  const provider = (process.env.BRAIN_PROVIDER ?? "mock").trim().toLowerCase();
  if (provider !== "mock" && provider !== "codex" && provider !== "glm") {
    throw new Error(`Unsupported BRAIN_PROVIDER: ${provider}`);
  }
  const codexTransport = (process.env.CODEX_TRANSPORT ?? "sdk").trim().toLowerCase();
  if (codexTransport !== "sdk" && codexTransport !== "queue") {
    throw new Error(`Unsupported CODEX_TRANSPORT: ${codexTransport}`);
  }
  const codexRouting = (process.env.WITCH_ROUTING ?? "single").trim().toLowerCase();
  if (codexRouting !== "single" && codexRouting !== "auto") {
    throw new Error(`Unsupported WITCH_ROUTING: ${codexRouting}`);
  }
  const codexVisibleThreadId = process.env.WITCH_CODEX_THREAD_ID?.trim() || undefined;
  const teacherValue = (process.env.CODEX_TEACHER_ENABLED ?? "false").trim().toLowerCase();
  if (teacherValue !== "true" && teacherValue !== "false") {
    throw new Error("CODEX_TEACHER_ENABLED must be true or false");
  }
  const codexTeacherEnabled = teacherValue === "true";
  const configuredOutboundTo = process.env.QQ_SEND_TO?.trim() || undefined;
  const outboundTo = configuredOutboundTo ?? (csv(process.env.QQ_ALLOW_FROM).size === 1
    ? [...csv(process.env.QQ_ALLOW_FROM)][0]
    : undefined);
  const controlPort = Number(process.env.WITCH_CONTROL_PORT ?? "46002");
  if (!Number.isInteger(controlPort) || controlPort < 1 || controlPort > 65535) {
    throw new Error(`Invalid WITCH_CONTROL_PORT: ${process.env.WITCH_CONTROL_PORT}`);
  }
  const codexReplyTimeoutMs = Number(process.env.CODEX_REPLY_TIMEOUT_MS ?? "600000");
  if (!Number.isInteger(codexReplyTimeoutMs) || codexReplyTimeoutMs < 30_000 || codexReplyTimeoutMs > 1_800_000) {
    throw new Error("CODEX_REPLY_TIMEOUT_MS must be between 30000 and 1800000");
  }
  if (provider === "codex" && codexTransport === "queue" && !codexVisibleThreadId) {
    throw new Error("WITCH_CODEX_THREAD_ID is required when CODEX_TRANSPORT=queue");
  }
  if (codexTeacherEnabled && !codexVisibleThreadId) {
    throw new Error("WITCH_CODEX_THREAD_ID is required when CODEX_TEACHER_ENABLED=true");
  }
  const glmApiKey = process.env.GLM_API_KEY?.trim() || undefined;
  if (provider === "glm" && !glmApiKey) {
    throw new Error("GLM_API_KEY is required when BRAIN_PROVIDER=glm");
  }
  const glmReasoningEffort = (process.env.GLM_REASONING_EFFORT ?? "high").trim().toLowerCase();
  if (!["none", "minimal", "low", "medium", "high", "xhigh", "max"].includes(glmReasoningEffort)) {
    throw new Error(`Unsupported GLM_REASONING_EFFORT: ${glmReasoningEffort}`);
  }
  const glmMaxTokens = Number(process.env.GLM_MAX_TOKENS ?? "4096");
  if (!Number.isInteger(glmMaxTokens) || glmMaxTokens < 1 || glmMaxTokens > 131_072) {
    throw new Error("GLM_MAX_TOKENS must be between 1 and 131072");
  }
  const glmTimeoutMs = Number(process.env.GLM_TIMEOUT_MS ?? "180000");
  if (!Number.isInteger(glmTimeoutMs) || glmTimeoutMs < 10_000 || glmTimeoutMs > 600_000) {
    throw new Error("GLM_TIMEOUT_MS must be between 10000 and 600000");
  }
  const glmWebSearchTimeoutMs = Number(process.env.GLM_WEB_SEARCH_TIMEOUT_MS ?? "30000");
  if (!Number.isInteger(glmWebSearchTimeoutMs) || glmWebSearchTimeoutMs < 1000 || glmWebSearchTimeoutMs > 120000)
    throw new Error("GLM_WEB_SEARCH_TIMEOUT_MS must be between 1000 and 120000");
  const glmWebSearchTurnTimeoutMs = Number(process.env.GLM_WEB_SEARCH_TURN_TIMEOUT_MS ?? "180000");
  if (!Number.isInteger(glmWebSearchTurnTimeoutMs) || glmWebSearchTurnTimeoutMs < 10000 || glmWebSearchTurnTimeoutMs > 600000)
    throw new Error("GLM_WEB_SEARCH_TURN_TIMEOUT_MS must be between 10000 and 600000");
  const webSearchValue = (process.env.GLM_WEB_SEARCH_ENABLED ?? "false").trim().toLowerCase();
  if (webSearchValue !== "true" && webSearchValue !== "false") {
    throw new Error("GLM_WEB_SEARCH_ENABLED must be true or false");
  }
  const glmWebSearchProvider = (process.env.GLM_WEB_SEARCH_PROVIDER ?? "zhipu").trim().toLowerCase();
  if (!(new Set(["exa", "zhipu", "brave", "tavily", "baidu", "exa-brave", "exa-tavily", "exa-brave-tavily", "exa-tavily-baidu"])).has(glmWebSearchProvider)) {
    throw new Error("GLM_WEB_SEARCH_PROVIDER must be exa, zhipu, brave, tavily, baidu, exa-brave, exa-tavily, exa-brave-tavily, or exa-tavily-baidu");
  }
  const exaApiKey = process.env.EXA_API_KEY?.trim() || undefined;
  if (webSearchValue === "true" && (glmWebSearchProvider === "exa" || glmWebSearchProvider === "exa-brave" || glmWebSearchProvider === "exa-tavily" || glmWebSearchProvider === "exa-brave-tavily" || glmWebSearchProvider === "exa-tavily-baidu") && !exaApiKey) {
    throw new Error("EXA_API_KEY is required when GLM_WEB_SEARCH_PROVIDER uses Exa and GLM_WEB_SEARCH_ENABLED=true");
  }
  const braveSearchApiKey = process.env.BRAVE_SEARCH_API_KEY?.trim() || undefined;
  if (webSearchValue === "true" && (glmWebSearchProvider === "brave" || glmWebSearchProvider === "exa-brave" || glmWebSearchProvider === "exa-brave-tavily") && !braveSearchApiKey) {
    throw new Error("BRAVE_SEARCH_API_KEY is required when GLM_WEB_SEARCH_PROVIDER uses Brave and GLM_WEB_SEARCH_ENABLED=true");
  }
  const tavilyApiKey = process.env.TAVILY_API_KEY?.trim() || undefined;
  if (webSearchValue === "true" && (glmWebSearchProvider === "tavily" || glmWebSearchProvider === "exa-tavily" || glmWebSearchProvider === "exa-brave-tavily" || glmWebSearchProvider === "exa-tavily-baidu") && !tavilyApiKey) {
    throw new Error("TAVILY_API_KEY is required when GLM_WEB_SEARCH_PROVIDER uses Tavily and GLM_WEB_SEARCH_ENABLED=true");
  }
  const baiduAppBuilderApiKey = process.env.BAIDU_APPBUILDER_API_KEY?.trim() || undefined;
  if (webSearchValue === "true" && (glmWebSearchProvider === "baidu" || glmWebSearchProvider === "exa-tavily-baidu") && !baiduAppBuilderApiKey) {
    throw new Error("BAIDU_APPBUILDER_API_KEY is required when GLM_WEB_SEARCH_PROVIDER uses Baidu and GLM_WEB_SEARCH_ENABLED=true");
  }
  const braveSearchTimeoutMs = Number(process.env.BRAVE_SEARCH_TIMEOUT_MS ?? "30000");
  if (!Number.isInteger(braveSearchTimeoutMs) || braveSearchTimeoutMs < 1000 || braveSearchTimeoutMs > 120000) {
    throw new Error("BRAVE_SEARCH_TIMEOUT_MS must be between 1000 and 120000");
  }
  const tavilySearchTimeoutMs = Number(process.env.TAVILY_SEARCH_TIMEOUT_MS ?? "30000");
  if (!Number.isInteger(tavilySearchTimeoutMs) || tavilySearchTimeoutMs < 1000 || tavilySearchTimeoutMs > 120000) {
    throw new Error("TAVILY_SEARCH_TIMEOUT_MS must be between 1000 and 120000");
  }
  const baiduSearchTimeoutMs = Number(process.env.BAIDU_SEARCH_TIMEOUT_MS ?? "30000");
  if (!Number.isInteger(baiduSearchTimeoutMs) || baiduSearchTimeoutMs < 1000 || baiduSearchTimeoutMs > 120000) {
    throw new Error("BAIDU_SEARCH_TIMEOUT_MS must be between 1000 and 120000");
  }
  const baiduSearchCount = Number(process.env.BAIDU_SEARCH_RESULT_COUNT ?? "10");
  if (!Number.isInteger(baiduSearchCount) || baiduSearchCount < 1 || baiduSearchCount > 50) {
    throw new Error("BAIDU_SEARCH_RESULT_COUNT must be between 1 and 50");
  }
  const exaTimeoutMs = Number(process.env.EXA_TIMEOUT_MS ?? "30000");
  if (!Number.isInteger(exaTimeoutMs) || exaTimeoutMs < 1000 || exaTimeoutMs > 120000) {
    throw new Error("EXA_TIMEOUT_MS must be between 1000 and 120000");
  }
  const exaCount = Number(process.env.EXA_RESULT_COUNT ?? "10");
  if (!Number.isInteger(exaCount) || exaCount < 1 || exaCount > 10) {
    throw new Error("EXA_RESULT_COUNT must be between 1 and 10");
  }
  const exaMaxCharactersPerResult = Number(process.env.EXA_MAX_CHARS_PER_RESULT ?? "3000");
  if (!Number.isInteger(exaMaxCharactersPerResult) || exaMaxCharactersPerResult < 500 || exaMaxCharactersPerResult > 3000) {
    throw new Error("EXA_MAX_CHARS_PER_RESULT must be between 500 and 3000");
  }
  const supportedSearchEngines: SearchEngine[] = ["search_std", "search_pro", "search_pro_sogou", "search_pro_quark"];
  const configuredSearchEngines = (process.env.GLM_WEB_SEARCH_ENGINES ?? "search_pro,search_pro_quark,search_pro_sogou")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (configuredSearchEngines.length === 0 || configuredSearchEngines.some((item) => !supportedSearchEngines.includes(item as SearchEngine))) {
    throw new Error("GLM_WEB_SEARCH_ENGINES must contain only: " + supportedSearchEngines.join(", "));
  }
  const glmWebSearchCount = Number(process.env.GLM_WEB_SEARCH_COUNT ?? "10");
  if (!Number.isInteger(glmWebSearchCount) || glmWebSearchCount < 1 || glmWebSearchCount > 50) {
    throw new Error("GLM_WEB_SEARCH_COUNT must be between 1 and 50");
  }
  const glmWebSearchContentSize = (process.env.GLM_WEB_SEARCH_CONTENT_SIZE ?? "high").trim().toLowerCase();
  if (glmWebSearchContentSize !== "medium" && glmWebSearchContentSize !== "high") {
    throw new Error("GLM_WEB_SEARCH_CONTENT_SIZE must be medium or high");
  }
  const glmModel = process.env.GLM_MODEL?.trim() || "glm-5.3-flash";
  if (glmModel === "glm-5.3-flash" && !["low", "high", "max"].includes(glmReasoningEffort)) {
    throw new Error("glm-5.3-flash only supports GLM_REASONING_EFFORT=low, high, or max");
  }

  const runtimeDir = path.resolve(process.env.WITCH_RUNTIME_DIR ?? "./runtime");
  return {
    onebotWsUrl: process.env.ONEBOT_WS_URL ?? "ws://127.0.0.1:46001",
    allowFrom: csv(process.env.QQ_ALLOW_FROM),
    outboundTo,
    controlPort,
    brainProvider: provider,
    codexTransport,
    codexRouting,
    codexVisibleThreadId,
    codexReplyTimeoutMs,
    personalityFile: path.resolve(process.env.WITCH_PERSONALITY_FILE ?? "./personality/witch.md"),
    memoryFile: path.resolve(process.env.WITCH_MEMORY_FILE ?? "./memory/core.md"),
    runtimeDir,
    projectsRoot: path.resolve(process.env.WITCH_PROJECTS_ROOT ?? path.join(runtimeDir, "projects")),
    glmApiKey,
    glmBaseUrl: (process.env.GLM_BASE_URL ?? "https://open.bigmodel.cn/api/paas/v4").replace(/\/$/, ""),
    glmModel,
    glmReasoningEffort: glmReasoningEffort as Config["glmReasoningEffort"],
    glmMaxTokens,
    glmTimeoutMs,
    glmWebSearchTimeoutMs,
    glmWebSearchTurnTimeoutMs,
    glmWebSearchEnabled: webSearchValue === "true",
    glmWebSearchProvider: glmWebSearchProvider as Config["glmWebSearchProvider"],
    exaApiKey,
    braveSearchApiKey,
    tavilyApiKey,
    baiduAppBuilderApiKey,
    braveSearchTimeoutMs,
    tavilySearchTimeoutMs,
    baiduSearchTimeoutMs,
    baiduSearchCount,
    exaTimeoutMs,
    exaCount,
    exaMaxCharactersPerResult,
    glmWebSearchEngines: [...new Set(configuredSearchEngines)] as SearchEngine[],
    glmWebSearchCount,
    glmWebSearchContentSize: glmWebSearchContentSize as SearchContentSize,
    codexTeacherEnabled,
    codexTeacherSkillFile: path.resolve(process.env.CODEX_TEACHER_SKILL_FILE ?? "./skills/codex-teacher/SKILL.md"),
  };
}
