import { loadConfig } from "./config.js";
import { CodexBrain } from "./brain/codex.js";
import { CodexQueueBrain } from "./brain/codex-queue.js";
import { CodexRouterBrain } from "./brain/codex-router.js";
import { MockBrain } from "./brain/mock.js";
import { GlmBrain } from "./brain/glm.js";
import { DelegatingBrain } from "./brain/delegating.js";
import { SunshineModeExtension } from "./brain/sunshine-mode.js";
import { BaiduWebSearch, BraveLlmContextSearch, ExaBraveWebSearch, ExaWebSearch, TavilyWebSearch, ZhipuWebSearch } from "./brain/web-search.js";
import { MemoryContextExtension } from "./brain/memory.js";
import { OneBotChannel } from "./channel/onebot.js";
import { getOrCreateControlToken, WitchControlServer } from "./control-server.js";
import { loadPersonality } from "./personality.js";
import { SessionStore } from "./session-store.js";
import { SchoolRegistry } from "./school-registry.js";
import type { Brain } from "./types.js";
import { MessageLedger } from "./message-ledger.js";
import { MemoryManager } from "./memory/manager.js";
import { TurnRuntime } from "./runtime/turn-runtime.js";
import type { TurnExtension } from "./runtime/types.js";
import fs from "node:fs/promises";

async function main(): Promise<void> {
  const config = loadConfig();
  const sessions = await SessionStore.open(config.runtimeDir);
  const ledger = await MessageLedger.open(config.runtimeDir);
  const memory = await MemoryManager.open(config.runtimeDir);
  const personality = await loadPersonality(config.personalityFile, config.memoryFile);
  let brain: Brain;
  if (config.brainProvider === "codex") {
    brain = config.codexTransport === "queue"
      ? config.codexRouting === "auto"
        ? new CodexRouterBrain(sessions, personality, config.codexVisibleThreadId!, config.projectsRoot, config.codexReplyTimeoutMs)
        : new CodexQueueBrain(config.codexVisibleThreadId!, personality, config.codexReplyTimeoutMs)
      : new CodexBrain(sessions, personality);
  } else if (config.brainProvider === "glm") {
    const webSearch = config.glmWebSearchEnabled
      ? config.glmWebSearchProvider === "exa"
        ? new ExaWebSearch({
          apiKey: config.exaApiKey!,
          timeoutMs: config.exaTimeoutMs,
          count: config.exaCount,
          maxCharactersPerResult: config.exaMaxCharactersPerResult,
        })
      : config.glmWebSearchProvider === "exa-brave" || config.glmWebSearchProvider === "exa-tavily" || config.glmWebSearchProvider === "exa-brave-tavily" || config.glmWebSearchProvider === "exa-tavily-baidu"
        ? new ExaBraveWebSearch(
          new ExaWebSearch({
            apiKey: config.exaApiKey!,
            timeoutMs: config.exaTimeoutMs,
            count: config.exaCount,
            maxCharactersPerResult: config.exaMaxCharactersPerResult,
          }),
          config.glmWebSearchProvider === "exa-tavily" || config.glmWebSearchProvider === "exa-tavily-baidu"
            ? new TavilyWebSearch({ apiKey: config.tavilyApiKey!, timeoutMs: config.tavilySearchTimeoutMs, count: 5 })
            : new BraveLlmContextSearch({
              apiKey: config.braveSearchApiKey!,
              timeoutMs: config.braveSearchTimeoutMs,
              count: 5,
              maxUrls: 5,
            }),
          config.glmWebSearchProvider === "exa-brave-tavily"
            ? new TavilyWebSearch({ apiKey: config.tavilyApiKey!, timeoutMs: config.tavilySearchTimeoutMs, count: 5 })
            : config.glmWebSearchProvider === "exa-tavily-baidu"
            ? new BaiduWebSearch({ apiKey: config.baiduAppBuilderApiKey!, timeoutMs: config.baiduSearchTimeoutMs, count: config.baiduSearchCount })
            : undefined,
        )
        : config.glmWebSearchProvider === "tavily"
        ? new TavilyWebSearch({ apiKey: config.tavilyApiKey!, timeoutMs: config.tavilySearchTimeoutMs, count: 5 })
        : config.glmWebSearchProvider === "baidu"
        ? new BaiduWebSearch({ apiKey: config.baiduAppBuilderApiKey!, timeoutMs: config.baiduSearchTimeoutMs, count: config.baiduSearchCount })
        : config.glmWebSearchProvider === "brave"
        ? new BraveLlmContextSearch({
          apiKey: config.braveSearchApiKey!,
          timeoutMs: config.braveSearchTimeoutMs,
        })
          : new ZhipuWebSearch({
          apiKey: config.glmApiKey!,
          baseUrl: config.glmBaseUrl,
          timeoutMs: config.glmTimeoutMs,
          engines: config.glmWebSearchEngines,
          count: config.glmWebSearchCount,
          contentSize: config.glmWebSearchContentSize,
          })
      : undefined;
    const glm = new GlmBrain({
        apiKey: config.glmApiKey!,
        baseUrl: config.glmBaseUrl,
        model: config.glmModel,
        reasoningEffort: config.glmReasoningEffort,
        maxTokens: config.glmMaxTokens,
        timeoutMs: config.glmTimeoutMs,
        webSearch,
      }, personality);
    if (config.codexTeacherEnabled) {
      const teacherSkill = (await fs.readFile(config.codexTeacherSkillFile, "utf8")).trim();
      if (!teacherSkill) throw new Error(`Codex teacher skill is empty: ${config.codexTeacherSkillFile}`);
      const teacherSessions = await SessionStore.open(`${config.runtimeDir}/codex-teacher`);
      const school = await SchoolRegistry.open(`${config.runtimeDir}/codex-teacher`);
      // Adopt the one existing bridge-verified classroom during migration.
      for (const record of Object.values(teacherSessions.all())) {
        if (record.routeManaged && record.projectId && record.projectName && record.threadId && record.threadName
          && !school.findExact(record.projectName, record.threadName)) {
          await school.register({
            projectId: record.projectId,
            projectName: record.projectName,
            threadId: record.threadId,
            threadName: record.threadName,
          });
        }
      }
      const teacher = new CodexRouterBrain(
        teacherSessions,
        personality,
        config.codexVisibleThreadId!,
        config.projectsRoot,
        config.codexReplyTimeoutMs,
        "teacher",
        school,
      );
      brain = new DelegatingBrain(glm, teacher, teacherSkill);
    } else {
      brain = glm;
    }
  } else {
    brain = new MockBrain();
  }

  const extensions: TurnExtension[] = [
    new MemoryContextExtension(memory),
    new SunshineModeExtension(),
  ];
  brain = new TurnRuntime(brain, extensions);

  console.log(`[witch] brain=${config.brainProvider}`);
  console.log("[witch] memory=explicit facts + relevant local conversation recall");
  console.log(`[witch] personality=${personality.id}@${personality.version}`);
  if (config.brainProvider === "codex") {
    console.log(`[witch] codex transport=${config.codexTransport}, routing=${config.codexRouting}`);
  }
  if (config.brainProvider === "glm") {
    console.log(`[witch] glm model=${config.glmModel}, reasoning=${config.glmReasoningEffort}`);
    console.log(`[witch] web search=${config.glmWebSearchEnabled ? "enabled" : "disabled"}`);
    if (config.glmWebSearchEnabled) {
      console.log(`[witch] web search provider=${config.glmWebSearchProvider}`);
    }
    console.log(`[witch] codex teacher=${config.codexTeacherEnabled ? "enabled" : "disabled"}`);
  }
  if (config.allowFrom.size === 0) {
    console.warn("[witch] QQ_ALLOW_FROM is empty; all inbound messages will be denied");
  }

  const channel = new OneBotChannel(config.onebotWsUrl, config.allowFrom, brain, config.runtimeDir, 7_000, ledger);
  await channel.start();
  const controlToken = await getOrCreateControlToken(config.runtimeDir);
  const control = new WitchControlServer(config.controlPort, controlToken, config.outboundTo, channel, ledger);
  try {
    await control.start();
  } catch (error) {
    channel.stop();
    throw error;
  }
  const shutdown = () => {
    control.stop();
    channel.stop();
    void Promise.resolve(brain.close?.()).finally(() => console.log("[witch] stopped"));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

main().catch((error) => {
  console.error("[witch] fatal error", error);
  process.exitCode = 1;
});
