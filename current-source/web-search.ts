import { requestJsonObject } from "./http-json.js";
import type { BrainRequest, BrainResponse, SearchQueryPlanner, WebSearchExecutor, WebSearchResult, WebSearchTaskContext } from "../types.js";
import type { TurnContext, TurnExtension } from "../runtime/types.js";

export type SearchEngine = "search_std" | "search_pro" | "search_pro_sogou" | "search_pro_quark";
export type SearchContentSize = "medium" | "high";

interface ZhipuSearchResponse {
  error?: { message?: string };
  search_result?: Array<{
    title?: string;
    link?: string;
    content?: string;
    media?: string;
    publish_date?: string;
  }>;
}

export interface WebSearchOptions {
  apiKey: string;
  baseUrl: string;
  timeoutMs: number;
  engines?: SearchEngine[];
  count?: number;
  contentSize?: SearchContentSize;
}

interface ExaSearchResponse {
  error?: string;
  tag?: string;
  requestId?: string;
  results?: Array<{
    title?: string;
    url?: string;
    publishedDate?: string;
    author?: string;
    text?: string;
    highlights?: string[];
    highlightScores?: number[];
    summary?: string;
  }>;
  costDollars?: { total?: number };
}

interface ExaContentsResponse {
  error?: string;
  tag?: string;
  requestId?: string;
  results?: Array<{
    id?: string;
    title?: string;
    url?: string;
    publishedDate?: string;
    author?: string;
    text?: string;
  }>;
  statuses?: Array<{ id?: string; status?: string; error?: { tag?: string } }>;
  costDollars?: { total?: number };
}

interface BraveLlmContextResponse {
  grounding?: {
    generic?: Array<{
      url?: string;
      title?: string;
      snippets?: string[];
    }>;
  };
  sources?: Record<string, { site_name?: string; description?: string }>;
  error?: { detail?: string; code?: string };
}

export interface BraveLlmContextSearchOptions {
  apiKey: string;
  baseUrl?: string;
  timeoutMs: number;
  count?: number;
  maxUrls?: number;
  maxTokens?: number;
  maxTokensPerUrl?: number;
}

interface TavilySearchResponse {
  results?: Array<{
    title?: string;
    url?: string;
    content?: string;
    published_date?: string | null;
  }>;
  usage?: { credits?: number };
  detail?: { error?: string };
}

interface BaiduSearchResponse {
  request_id?: string;
  code?: string | number;
  message?: string;
  references?: Array<{
    type?: string;
    title?: string;
    url?: string;
    content?: string;
    website?: string;
    date?: string;
    rerank_score?: number;
    authority_score?: number;
  }>;
}

export interface TavilyWebSearchOptions {
  apiKey: string;
  baseUrl?: string;
  timeoutMs: number;
  count?: number;
}

export interface BaiduWebSearchOptions {
  apiKey: string;
  baseUrl?: string;
  timeoutMs: number;
  count?: number;
}

export interface ExaSearchOptions {
  apiKey: string;
  baseUrl?: string;
  timeoutMs: number;
  count?: number;
  maxCharactersPerResult?: number;
  objective?: string;
}

const DEFAULT_EXA_OBJECTIVE = [
  "Find pages that directly answer the query's named facts and explicit subquestions.",
  "Prefer primary publisher or official documentation for official rules, dates, versions, and product facts; use independent reporting for context; use community guides for player-created strategies, clearly keeping them distinct from official facts.",
  "Rank pages with direct, specific evidence above generic SEO pages, advertisements, and unrelated background. Preserve source disagreement and version scope; do not merge different variants into one unsupported answer.",
].join(" ");

/**
 * Search first returns query-relevant passages. A separate bounded Contents
 * request fetches only discovered pages for quote validation and bounded
 * evidence-review context. Successful extraction does not prove completeness.
 */
export class ExaWebSearch {
  constructor(private readonly options: ExaSearchOptions) {}

  async searchWithFallback(query: string, signal?: AbortSignal, context?: WebSearchTaskContext): Promise<WebSearchResult[]> {
    const maxCharactersPerResult = Math.max(500, Math.min(this.options.maxCharactersPerResult ?? 3000, 3000));
    const { response, data: result } = await requestJsonObject<ExaSearchResponse>(`${this.options.baseUrl ?? "https://api.exa.ai"}/search`, {
      method: "POST",
      headers: {
        "x-api-key": this.options.apiKey,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        query,
        objective: buildExaObjective(this.options.objective ?? DEFAULT_EXA_OBJECTIVE, context),
        type: "auto",
        numResults: Math.max(1, Math.min(this.options.count ?? 10, 10)),
        // Exa's agent-oriented path returns query-relevant passages instead of
        // sending whole page bodies into the evidence reviewer.
        contents: { highlights: { query, maxCharacters: maxCharactersPerResult } },
      }),
    }, { signal, timeoutMs: this.options.timeoutMs, label: "Exa search" });
    if (!response.ok) {
      const detail = result.error ?? result.tag ?? `HTTP ${response.status}`;
      throw new Error(`Exa search failed (${detail})`);
    }
    const results = providerRows<NonNullable<ExaSearchResponse["results"]>[number]>(result.results, "Exa search")
      // Generated summaries are useful for discovery, but are not original
      // source passages and therefore cannot satisfy verbatim quote checks.
      .filter((item) => typeof item.title === "string" && item.title.trim())
      .map((item) => {
        let link = "";
        try {
          const parsed = new URL(item.url ?? "");
          if (parsed.protocol === "https:" && !parsed.username && !parsed.password) link = parsed.toString();
        } catch { /* Keep source text, but never expose a non-public citation target. */ }
        return {
          title: item.title!.slice(0, 500),
          link,
          content: (orderHighlightsByScore(item.highlights, item.highlightScores).join("\n")
            || (typeof item.text === "string" ? item.text : "")).trim().slice(0, maxCharactersPerResult),
          media: link ? new URL(link).hostname : undefined,
          publishDate: boundedPageMetadata(item.publishedDate, 80),
          author: boundedPageMetadata(item.author, 160),
          searchProviders: ["exa" as const],
        };
      }).filter((item) => item.content.length > 0);
    const estimatedCost = typeof result.costDollars?.total === "number"
      ? ` estimatedCostUsd=${result.costDollars.total.toFixed(6)}` : "";
    console.log(`[web-search] provider=exa results=${results.length}${result.requestId ? ` request=${result.requestId}` : ""}${estimatedCost}`);
    return results;
  }

  async enrichResults(results: WebSearchResult[], signal?: AbortSignal): Promise<WebSearchResult[]> {
    signal?.throwIfAborted();
    // Fragments do not identify a different fetched document. Deduplicate before
    // applying the request limit so eight anchors cannot crowd out other pages.
    const candidates = new Map<string, WebSearchResult>();
    for (const source of results) {
      if (source.fullPageFetched && hasReadablePageText(source.verificationContent)) continue;
      const key = contentsUrlKey(source.link);
      if (key && !candidates.has(key) && candidates.size < 8) candidates.set(key, source);
    }
    if (candidates.size === 0) return results;
    const { response, data: result } = await requestJsonObject<ExaContentsResponse>(`${this.options.baseUrl ?? "https://api.exa.ai"}/contents`, {
      method: "POST",
      headers: { "x-api-key": this.options.apiKey, "content-type": "application/json" },
      body: JSON.stringify({
        urls: [...candidates.keys()],
        text: { maxCharacters: EXA_PAGE_CHARACTER_LIMIT },
      }),
    }, { signal, timeoutMs: this.options.timeoutMs, label: "Exa contents" });
    if (!response.ok) {
      const detail = result.error ?? result.tag ?? `HTTP ${response.status}`;
      throw new Error(`Exa contents failed (${detail})`);
    }
    // A 200 response may contain failed URLs. Never turn a provider error page
    // into verified evidence, and never bind entries by their array positions.
    const failed = new Set((Array.isArray(result.statuses) ? result.statuses : []).flatMap((item) => {
      const key = item && typeof item === "object" ? contentsUrlKey(item.id) : undefined;
      return key && item.status !== "success" ? [key] : [];
    }));
    const fetched = new Map<string, NonNullable<ExaContentsResponse["results"]>[number]>();
    const empty = new Set<string>();
    for (const item of Array.isArray(result.results) ? result.results : []) {
      if (!item || typeof item !== "object") continue;
      const urlKey = contentsUrlKey(item.url);
      const idKey = contentsUrlKey(item.id);
      const keys = new Set<string>();
      if (urlKey && candidates.has(urlKey)) keys.add(urlKey);
      // Exa can retain the requested document id after a redirect. Only accept
      // an explicit id and a same-origin URL: cross-origin content must not
      // inherit the source identity/authority of the originally requested URL.
      if (idKey && candidates.has(idKey) && urlKey &&
          new URL(idKey).origin === new URL(urlKey).origin) keys.add(idKey);
      for (const key of keys) {
        if (failed.has(key) || typeof item.text !== "string") continue;
        const text = item.text.slice(0, EXA_PAGE_CHARACTER_LIMIT);
        if (hasReadablePageText(text)) {
          // Do not let an empty duplicate replace successful extraction.
          if (!fetched.has(key)) fetched.set(key, item);
        } else empty.add(key);
      }
    }
    const enriched = results.map((source): WebSearchResult => {
      if (source.fullPageFetched && hasReadablePageText(source.verificationContent)) return source;
      const key = contentsUrlKey(source.link);
      if (!key || !candidates.has(key)) return source;
      const page = fetched.get(key);
      if (!page || typeof page.text !== "string") return {
        ...source,
        verificationContent: undefined,
        fullPageFetched: false,
        pageContentStatus: empty.has(key) && !failed.has(key) ? "empty" : "unavailable",
      };
      return {
        ...source,
        title: boundedPageMetadata(page.title, 240) || source.title,
        publishDate: boundedPageMetadata(page.publishedDate, 80) || source.publishDate,
        author: boundedPageMetadata(page.author, 160) || source.author,
        // Keep each page's original Search excerpt. Re-highlighting a batch
        // with one shared query can overwrite passages from other queries.
        content: source.content,
        verificationContent: page.text.slice(0, EXA_PAGE_CHARACTER_LIMIT).trim(),
        fullPageFetched: true,
        // Reaching the extraction limit may mean truncation, even if trimming
        // later shortens the stored text. Below the limit is still not proof
        // that the extractor saw every part of the publisher's page.
        pageContentStatus: page.text.length >= EXA_PAGE_CHARACTER_LIMIT ? "truncated" : "available",
      };
    });
    const estimatedCost = typeof result.costDollars?.total === "number"
      ? ` estimatedCostUsd=${result.costDollars.total.toFixed(6)}` : "";
    console.log(`[web-search] provider=exa contents=${fetched.size}/${candidates.size}${result.requestId ? ` request=${result.requestId}` : ""}${estimatedCost}`);
    return enriched;
  }

}

const EXA_PAGE_CHARACTER_LIMIT = 12_000;

/** URL identity only; this does not perform a local crawl or DNS resolution. */
function contentsUrlKey(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 2048) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return undefined;
    url.hash = "";
    const key = url.toString();
    return key.length <= 2048 ? key : undefined;
  } catch { return undefined; }
}

function hasReadablePageText(value: unknown): value is string {
  return typeof value === "string" && /[^\s\p{Cc}\p{Cf}]/u.test(value);
}

function boundedPageMetadata(value: unknown, limit: number): string | undefined {
  return typeof value === "string" ? value.trim().slice(0, limit) || undefined : undefined;
}

function buildExaObjective(base: string, context?: WebSearchTaskContext): string {
  const bounded = (value: string, limit: number): string => value
    .replace(/[\u0000-\u001f\u007f]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, limit);
  const points = context?.requestedPoints
    .slice(0, 6)
    .map((point) => `${point.id}. ${bounded(point.text, 160)}`)
    .filter((point) => point.length > 3) ?? [];
  const constraints = context?.responseConstraints
    .slice(0, 8)
    .map((constraint) => bounded(constraint, 240))
    .filter(Boolean) ?? [];
  const taskContext = [
    points.length ? `This query supports these explicit answer points: ${points.join("; ")}.` : "",
    constraints.length ? `Honor these evidence and reporting constraints while selecting documents: ${constraints.join("; ")}.` : "",
  ].filter(Boolean).join(" ");
  // Exa caps objective at 4096 characters. Context is bounded separately so
  // an oversized model-authored plan cannot silently crowd out the base goal.
  return `${bounded(base, 800)}${taskContext ? ` ${taskContext}` : ""}`.slice(0, 4096);
}

/**
 * Brave's LLM Context endpoint returns source-linked, pre-extracted chunks
 * intended for RAG. The chunks remain untrusted evidence and are verified by
 * the same quote-review pipeline as every other search provider.
 */
export class BraveLlmContextSearch {
  constructor(private readonly options: BraveLlmContextSearchOptions) {}

  async searchWithFallback(query: string, signal?: AbortSignal): Promise<WebSearchResult[]> {
    const baseUrl = (this.options.baseUrl ?? "https://api.search.brave.com/res/v1/llm/context").replace(/\/$/u, "");
    const { response, data: result } = await requestJsonObject<BraveLlmContextResponse>(baseUrl, {
      method: "POST",
      headers: {
        "x-subscription-token": this.options.apiKey,
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        q: query,
        country: "CN",
        search_lang: "zh-hans",
        count: Math.max(1, Math.min(this.options.count ?? 10, 50)),
        maximum_number_of_urls: Math.max(1, Math.min(this.options.maxUrls ?? 10, 50)),
        maximum_number_of_tokens: Math.max(1024, Math.min(this.options.maxTokens ?? 8192, 32768)),
        maximum_number_of_tokens_per_url: Math.max(512, Math.min(this.options.maxTokensPerUrl ?? 2048, 8192)),
        context_threshold_mode: "balanced",
        enable_source_metadata: true,
      }),
    }, { signal, timeoutMs: this.options.timeoutMs, label: "Brave LLM Context" });
    if (!response.ok) {
      throw new Error(`Brave LLM Context failed (${result.error?.code ?? result.error?.detail ?? `HTTP ${response.status}`})`);
    }
    const results = providerRows<NonNullable<NonNullable<BraveLlmContextResponse["grounding"]>["generic"]>[number]>(result.grounding?.generic, "Brave LLM Context")
      .flatMap((item) => {
        const snippets = (Array.isArray(item.snippets) ? item.snippets : []).filter((snippet) => typeof snippet === "string" && snippet.trim());
        if (typeof item.title !== "string" || !item.title.trim() || snippets.length === 0) return [];
        let link = "";
        try {
          const parsed = new URL(item.url ?? "");
          if (parsed.protocol === "https:" && !parsed.username && !parsed.password) link = parsed.toString();
        } catch { /* Keep the passage but never expose an unsafe citation target. */ }
        const metadata = item.url ? result.sources?.[item.url] : undefined;
        return [{
          title: item.title,
          link,
          content: snippets.join("\n\n").slice(0, 12_000),
          media: boundedPageMetadata(metadata?.site_name, 160),
          searchProviders: ["brave" as const],
        }];
      });
    console.log(`[web-search] provider=brave-llm-context results=${results.length} query=${JSON.stringify(query.slice(0, 80))}`);
    return results;
  }
}

/** Tavily basic search returns source-linked snippets; no generated answer or raw page body is requested. */
export class TavilyWebSearch {
  constructor(private readonly options: TavilyWebSearchOptions) {}

  async searchWithFallback(query: string, signal?: AbortSignal): Promise<WebSearchResult[]> {
    const baseUrl = (this.options.baseUrl ?? "https://api.tavily.com/search").replace(/\/$/u, "");
    const { response, data: result } = await requestJsonObject<TavilySearchResponse>(baseUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.options.apiKey}`,
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        query,
        search_depth: "basic",
        max_results: Math.max(1, Math.min(this.options.count ?? 5, 10)),
        chunks_per_source: 3,
        include_answer: false,
        include_raw_content: false,
        include_usage: true,
        country: "china",
        language: "zh",
      }),
    }, { signal, timeoutMs: this.options.timeoutMs, label: "Tavily Search" });
    if (!response.ok) {
      throw new Error(`Tavily Search failed (${result.detail?.error ?? `HTTP ${response.status}`})`);
    }
    const results = providerRows<NonNullable<TavilySearchResponse["results"]>[number]>(result.results, "Tavily Search").flatMap((item) => {
      if (typeof item.title !== "string" || !item.title.trim() || typeof item.content !== "string" || !item.content.trim()) return [];
      let link = "";
      try {
        const parsed = new URL(item.url ?? "");
        if (parsed.protocol === "https:" && !parsed.username && !parsed.password) link = parsed.toString();
      } catch { /* Do not expose unsafe URLs as citations. */ }
      if (!link) return [];
      return [{
        title: item.title.slice(0, 500),
        link,
        content: item.content.slice(0, 12_000),
        publishDate: boundedPageMetadata(item.published_date, 80),
        searchProviders: ["tavily" as const],
      }];
    });
    console.log(`[web-search] provider=tavily results=${results.length} credits=${result.usage?.credits ?? "unknown"} query=${JSON.stringify(query.slice(0, 80))}`);
    return results;
  }
}

/** Baidu Qianfan returns source-linked snippets only; Witch fetches and verifies candidate pages separately. */
export class BaiduWebSearch {
  constructor(private readonly options: BaiduWebSearchOptions) {}

  async searchWithFallback(query: string, signal?: AbortSignal): Promise<WebSearchResult[]> {
    const endpoint = this.options.baseUrl ?? "https://qianfan.baidubce.com/v2/ai_search/web_search";
    const { response, data: result } = await requestJsonObject<BaiduSearchResponse>(endpoint, {
      method: "POST",
      redirect: "error",
      headers: {
        "X-Appbuilder-Authorization": `Bearer ${this.options.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        messages: [{ role: "user", content: query }],
        search_source: "baidu_search_v2",
        resource_type_filter: [{ type: "web", top_k: Math.max(1, Math.min(this.options.count ?? 10, 50)) }],
      }),
    }, { signal, timeoutMs: this.options.timeoutMs, label: "Baidu Search" });
    if (!response.ok || (result.code !== undefined && result.code !== 0 && result.code !== "0")) {
      const detail = typeof result.message === "string" ? result.message.slice(0, 240) : `HTTP ${response.status}`;
      throw new Error(`Baidu Search failed (${detail})`);
    }
    if (!Array.isArray(result.references)) throw new Error("Baidu Search returned an invalid response schema");

    const seen = new Set<string>();
    const results = providerRows<NonNullable<BaiduSearchResponse["references"]>[number]>(result.references, "Baidu Search").flatMap((item) => {
      if (item.type && item.type !== "web") return [];
      if (typeof item.title !== "string" || !item.title.trim()
        || typeof item.content !== "string" || !item.content.trim()) return [];
      let link = "";
      try {
        const parsed = new URL(item.url ?? "");
        if (parsed.protocol === "https:" && !parsed.username && !parsed.password) link = parsed.toString();
      } catch { /* Never expose unsafe or malformed citation targets. */ }
      if (!link || seen.has(link)) return [];
      seen.add(link);
      return [{
        title: item.title.slice(0, 500),
        link,
        content: item.content.slice(0, 12_000),
        media: boundedPageMetadata(item.website, 160),
        publishDate: boundedPageMetadata(item.date, 80),
        searchProviders: ["baidu" as const],
      }];
    }).slice(0, Math.max(1, Math.min(this.options.count ?? 10, 50)));
    console.log(`[web-search] provider=baidu results=${results.length} query=${JSON.stringify(query.slice(0, 80))}`);
    return results;
  }
}

/**
 * Queries two independent indexes concurrently, then interleaves their ranked
 * results before handing them to the shared evidence-review pipeline. A
 * provider failure is isolated as long as the other provider returns usable
 * results; neither provider's rank is treated as factual authority.
 */
export class ExaBraveWebSearch implements WebSearchExecutor {
  private readonly brave?: BraveLlmContextSearch;
  private readonly tavily?: TavilyWebSearch;
  private readonly baidu?: BaiduWebSearch;

  constructor(
    private readonly exa: ExaWebSearch,
    secondary: BraveLlmContextSearch | TavilyWebSearch,
    supplemental?: TavilyWebSearch | BaiduWebSearch,
  ) {
    if (secondary instanceof TavilyWebSearch) this.tavily = secondary;
    else this.brave = secondary;
    if (supplemental instanceof BaiduWebSearch) this.baidu = supplemental;
    else if (supplemental) this.tavily = supplemental;
  }

  async searchWithFallback(
    query: string,
    signal?: AbortSignal,
    context?: WebSearchTaskContext,
  ): Promise<WebSearchResult[]> {
    const providers = [
      { name: "exa" as const, run: () => this.exa.searchWithFallback(query, signal, context) },
      ...(this.brave ? [{ name: "brave" as const, run: () => this.brave!.searchWithFallback(query, signal) }] : []),
      ...(this.tavily ? [{ name: "tavily" as const, run: () => this.tavily!.searchWithFallback(query, signal) }] : []),
      ...(this.baidu ? [{ name: "baidu" as const, run: () => this.baidu!.searchWithFallback(query, signal) }] : []),
    ];
    signal?.throwIfAborted();
    const settled = await Promise.allSettled(providers.map((provider) => provider.run()));
    signal?.throwIfAborted();
    const queues = settled.flatMap((result, index) => {
      const provider = providers[index]!;
      if (result.status === "rejected") {
        console.warn(`[web-search] provider=${provider.name} failed; retaining the independent index result`);
        return [];
      }
      return [result.value.map((source, resultIndex) => ({
        ...source,
        searchProviders: [provider.name],
        searchRanks: [{ query, provider: provider.name, rank: resultIndex + 1 }],
        searchExcerpts: [{ query, text: source.content, provider: provider.name }],
      }))];
    });
    if (queues.length === 0) {
      const errors = settled.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
      throw new AggregateError(errors, "All configured web search providers failed.");
    }

    const merged = new Map<string, WebSearchResult>();
    const offsets = queues.map(() => 0);
    let addedInPass = true;
    while (addedInPass) {
      addedInPass = false;
      for (let queueIndex = 0; queueIndex < queues.length; queueIndex += 1) {
        const source = queues[queueIndex]![offsets[queueIndex]!];
        if (!source) continue;
        offsets[queueIndex] = offsets[queueIndex]! + 1;
        addedInPass = true;
        let key = source.link;
        try {
          const parsed = new URL(source.link);
          if (parsed.protocol !== "https:" || parsed.username || parsed.password) continue;
          parsed.hash = "";
          key = parsed.toString();
        } catch {
          continue;
        }
        const previous = merged.get(key);
        if (!previous) merged.set(key, source);
        else merged.set(key, {
          ...previous,
          searchProviders: [...new Set([...(previous.searchProviders ?? []), ...(source.searchProviders ?? [])])],
          searchRanks: mergeProviderRanks(previous.searchRanks, source.searchRanks),
          searchExcerpts: [...new Map([
            ...(previous.searchExcerpts ?? []), ...(source.searchExcerpts ?? []),
          ].map((excerpt) => [`${excerpt.provider ?? ""}\u0000${excerpt.query}\u0000${excerpt.text}`, excerpt])).values()],
        });
      }
    }
    const results = [...merged.values()];
    console.log(`[web-search] providers=${providers.map((provider) => provider.name).join(",")} results=${results.length} query=${JSON.stringify(query.slice(0, 80))}`);
    return results;
  }

  async enrichResults(results: WebSearchResult[], signal?: AbortSignal): Promise<WebSearchResult[]> {
    return this.exa.enrichResults(results, signal);
  }
}

function mergeProviderRanks(
  ...rankSets: Array<WebSearchResult["searchRanks"]>
): WebSearchResult["searchRanks"] {
  const bestRankByList = new Map<string, NonNullable<WebSearchResult["searchRanks"]>[number]>();
  for (const rank of rankSets.flatMap((set) => set ?? [])) {
    if (!Number.isInteger(rank.rank) || rank.rank < 1 || !rank.query.trim()) continue;
    const key = `${rank.query}\u0000${rank.provider}`;
    const previous = bestRankByList.get(key);
    if (!previous || rank.rank < previous.rank) bestRankByList.set(key, rank);
  }
  return [...bestRankByList.values()];
}

/**
 * Exa returns one similarity score per highlight. Use scores only to order
 * passages when the response is complete and well-formed; never threshold
 * passages based on score. The existing character cap can still truncate the
 * tail, so higher-similarity passages reach the model first.
 */
function providerRows<T extends object>(value: unknown, label: string): T[] {
  if (!Array.isArray(value)) throw new Error(`${label} returned an invalid result collection schema`);
  return value.filter((item): item is T => item !== null && typeof item === "object" && !Array.isArray(item));
}
function orderHighlightsByScore(highlights: string[] | undefined, scores: number[] | undefined): string[] {
  if (!Array.isArray(highlights)) return [];
  const alignedScores = Array.isArray(scores) && scores.length === highlights.length
    && scores.every((score) => typeof score === "number" && Number.isFinite(score));
  return highlights.map((text, index) => ({ text, index, score: alignedScores ? scores![index]! : 0 }))
    .filter((item) => typeof item.text === "string" && item.text.trim())
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map((item) => item.text);
}

const LEADING_ACKNOWLEDGEMENT = /^(?:好(?:的|吧|呀|啊|呢|滴|德)?|嗯(?:嗯|呐|呢)?|行(?:的)?|可以(?:的)?|那就|麻烦你)\s*[，,、:：]?\s*/iu;
const LOOKUP_COMMAND = /^(?:帮我)?(?:联网(?:搜索|查一下?|搜一下?)|网上(?:搜索|查一下?|搜一下?)|搜索|搜一下?|搜搜|查一下?|查查|查一查|查找|找资料|了解一下|看看)(?:\s*[：:，,、]\s*|\s+)(.+)$/iu;
const EMBEDDED_LOOKUP_COMMAND = /(?:^|[，,。；;！？!?\s])(?:帮我)?(?:去|来)?(?:联网(?:搜索|查一下?|搜一下?)|网上(?:搜索|查一下?|搜一下?)|搜索|搜一下?|搜搜|查一下?|查查|查一查|查找|找资料|了解一下|看看)\s*[：:，,、]?\s*(.+)$/iu;
const OWN_SEARCH_CORRECTION = /(?:(?:动用|用|使用).{0,8}(?:你自己|自己的).{0,8}(?:联网|搜索|查)|(?:你自己|自己的).{0,8}(?:联网|搜索|查)|(?:不是|不要).{0,16}(?:codex|老师).{0,16}(?:你自己|联网|搜索|查))/iu;
const TRAILING_LOOKUP_COMMAND = /(?:联网(?:搜索|查一下?|搜一下?)|网上(?:搜索|查一下?|搜一下?)|搜索|搜一下?|搜搜|查一下?|查查|查一查|查找|找资料|了解一下)/giu;
const CONTEXT_DEPENDENT_QUERY = /(?:我)?(?:刚才|之前|前面|上面)(?:跟你)?(?:说|提|讲|问)?的|(?:这个|那个|这次|那次)(?:活动|游戏|东西|事情|问题|内容|产品|角色)?|(?:它|这件事|那件事)/iu;
const SEARCHABLE_TOPIC = /(?:游戏|手游|端游|网游|新游|开服|王者荣耀|王者万象棋|万象棋|自走棋|模拟战|棋手|英雄牌|阵营|角色|职业|boss|build|攻略|玩法|装备|副本|服务器|版本|更新|活动|卡池|设备|手机|电脑|软件|模型|api|电影|电视剧|书|天气|温度|降雨|空气质量|汇率|股价|航班|酒店|票价|商品|价格|配置|参数)/iu;
const FRESHNESS_CUE = /(?:今天|现在|当前|实时|最新|近期|最近|新出|新出的|刚出|刚上线|刚发布|即将|开服|发布|上线|更新|活动|价格|报价|库存|开售|折扣|营业时间|汇率|股价|航班|赛程)/iu;
const QUESTION_CUE = /[？?]|(?:是什么|怎么样|怎样|如何|怎么|哪些|哪几个|多少|什么时候|在哪里|值得|能不能|有没有|细节|详情|详细|介绍|玩法|角色|职业|攻略|价格|报价|库存|折扣)/iu;
const DETAIL_TOPIC = /(?:游戏|手游|端游|网游|新游|王者荣耀|王者万象棋|万象棋|自走棋|模拟战|棋手|软件|设备|模型|产品|电影|电视剧|书)/iu;
const DETAIL_CUE = /(?:细节|详情|详细|介绍|玩法|怎么玩|怎么打|阵容|阵营|流派|打法|运营|前期|中期|后期|核心机制|角色|职业|攻略|版本|更新|活动|配置|参数|评价|对比|识别|辨认|这是谁|这是什么|什么角色|什么游戏)/iu;

/**
 * Decides whether the owner is asking for information that needs the live web.
 *
 * This deliberately stays deterministic: a model should not spend API calls on
 * ordinary chat just because it sees a question mark.  It accepts the original
 * explicit commands, plus a narrower combination of (1) a request to look
 * something up and (2) a subject whose answer is likely to change over time.
 */
export function webSearchQuery(text: string): string | undefined {
  const input = text.trim().replace(LEADING_ACKNOWLEDGEMENT, "");
  if (!input || /^(?:不|别|不要|不用|无需)(?:联网|上网|搜索|查)/u.test(input)) return undefined;

  const explicit = input.match(LOOKUP_COMMAND);
  if (explicit?.[1]?.trim()) return trimQuery(explicit[1]);

  // Natural requests often introduce the test or reason first, then put the
  // real lookup after punctuation: "测试一下联网能力，查一下……". Search only
  // the requested topic, not the meta-conversation before it.
  const embedded = input.match(EMBEDDED_LOOKUP_COMMAND);
  if (embedded?.[1]?.trim()) return trimQuery(embedded[1]);

  const trailingCommands = [...input.matchAll(TRAILING_LOOKUP_COMMAND)];
  const lastCommand = trailingCommands.at(-1);
  if (lastCommand?.index !== undefined) {
    const topic = input
      .slice(lastCommand.index + lastCommand[0].length)
      .replace(/^\s*[：:，,、]?\s*/u, "")
      .trim();
    if (topic && (topic.length >= 4 || SEARCHABLE_TOPIC.test(topic) || QUESTION_CUE.test(topic))) {
      return trimQuery(topic);
    }
  }

  const asksToLookUp = /(?:^|[，,。！？\s])(?:帮我)?(?:查一下|查查|查一查|搜一下|搜搜|搜索|查找|找资料|了解一下|看看)/u.test(input);
  const hasSearchableTopic = SEARCHABLE_TOPIC.test(input);
  const hasFreshnessCue = FRESHNESS_CUE.test(input);
  const asksAQuestion = QUESTION_CUE.test(input);

  // Explicit lookup language is enough. For implicit requests, require a
  // recognizable topic plus either freshness, a question, or detail language;
  // this keeps ordinary chat such as "我最近在玩游戏" out of the search path.
  return asksToLookUp || (hasSearchableTopic && (asksAQuestion || (hasFreshnessCue && DETAIL_CUE.test(input))))
    ? trimQuery(input)
    : undefined;
}

function recoverConcreteQuery(request: BrainRequest): string | undefined {
  const history = request.history ?? [];
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const entry = history[index]!;
    if (entry.role !== "user") continue;
    const recovered = webSearchQuery(entry.text);
    if (recovered && !CONTEXT_DEPENDENT_QUERY.test(recovered)) return recovered;
  }
  return undefined;
}

async function contextualWebSearchQuery(
  request: BrainRequest,
  planner?: SearchQueryPlanner,
): Promise<string | undefined> {
  const direct = webSearchQuery(request.text);
  const needsContext = Boolean(direct && CONTEXT_DEPENDENT_QUERY.test(direct));
  const correction = OWN_SEARCH_CORRECTION.test(request.text);
  if (direct && !needsContext) return direct;
  const hasImage = request.attachments.some((item) => item.kind === "image" && Boolean(item.localPath));
  if (!direct && !correction && !hasImage) return undefined;

  if (hasImage && !direct && !correction && planner?.planImageWebSearchQuery) {
    try {
      const visualQuery = await planner.planImageWebSearchQuery(request);
      if (visualQuery) {
        console.log(`[web-search] planned visual query=${JSON.stringify(visualQuery)}`);
        return visualQuery;
      }
      return undefined;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.warn(`[web-search] visual planner failed: ${reason}`);
      return undefined;
    }
  }

  if (planner) {
    try {
      const planned = await planner.planWebSearchQuery(request, direct);
      if (planned && !CONTEXT_DEPENDENT_QUERY.test(planned)) return planned;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.warn(`[web-search] contextual planner failed: ${reason}`);
    }
  }

  const recovered = recoverConcreteQuery(request);
  if (recovered) console.log("[web-search] recovered concrete query from recent context");
  return recovered;
}

function trimQuery(query: string): string | undefined {
  const cleaned = query
    .trim()
    .replace(LEADING_ACKNOWLEDGEMENT, "")
    .replace(/^(?:帮我)?(?:联网|上网)?(?:搜索|查一下?|查查|查一查|搜一下?|搜搜|查找|找资料|了解一下|看看)\s*[:：，,、]?\s*/iu, "")
    .trim();
  return cleaned ? [...cleaned].slice(0, 70).join("") : undefined;
}

/**
 * A conservative retry for an empty result set.  Keep the subject, drop
 * common requested attributes, then ask for an official source.  This avoids
 * silently substituting a different model/product for the owner's request.
 */
export function webSearchFallbackQuery(query: string): string | undefined {
  if (/(?:官方|官网)/iu.test(query)) return undefined;
  const subject = coreSearchSubject(query);
  if (!subject || subject === query) return trimQuery(`${query} 官方`);
  return trimQuery(`${subject} 官方`);
}

/**
 * Builds a small, deterministic search plan.  The first query preserves the
 * user's wording; only an empty/error result advances to an official-source
 * query and then (for model/API questions) an API-focused query.
 */
export function webSearchQueryVariants(query: string): string[] {
  const variants = [query];
  const subject = coreSearchSubject(query);
  const visualIdentificationQuery = /(?:识别|辨认|这是谁|这是什么|哪个(?:英雄|角色|人物|游戏|设备|型号)|什么(?:英雄|角色|人物|游戏|设备|型号))/iu.test(query);
  const gameStrategyQuery = /(?:王者荣耀|王者万象棋|万象棋|自走棋|模拟战)/iu.test(query)
    && /(?:怎么玩|怎么打|阵容|阵营|流派|打法|运营|前期|中期|后期)/iu.test(query);
  if (visualIdentificationQuery) {
    const isGame = /(?:游戏|王者荣耀|王者万象棋|万象棋|自走棋|模拟战|英雄|棋手|角色)/iu.test(query);
    const atlasQuery = trimQuery(query + (isGame ? " 棋手图鉴 角色立绘" : " 型号 图鉴 外观特征"));
    if (atlasQuery && !variants.includes(atlasQuery)) variants.push(atlasQuery);
    const officialQuery = trimQuery(query + (isGame ? " 官方角色介绍" : " 官方产品介绍"));
    if (officialQuery && !variants.includes(officialQuery)) variants.push(officialQuery);
  } else if (gameStrategyQuery && subject) {
    const detailQuery = trimQuery(subject + " 阵容 运营 核心机制 前期");
    if (detailQuery && !variants.includes(detailQuery)) variants.push(detailQuery);
    const phaseQuery = trimQuery(subject + " 前期运营 中期成型 装备 天赋");
    if (phaseQuery && !variants.includes(phaseQuery)) variants.push(phaseQuery);
  } else if (DETAIL_TOPIC.test(query) && DETAIL_CUE.test(query) && subject) {
    const detailQuery = trimQuery(subject + " 玩法 角色 版本 详细资料");
    if (detailQuery && !variants.includes(detailQuery)) variants.push(detailQuery);
  }

  const officialQuery = webSearchFallbackQuery(query);
  if (officialQuery && !variants.includes(officialQuery)) variants.push(officialQuery);

  const asksAboutModelOrApi = /(?:api|模型|价格|报价|成本|能力|上下文|性能|发布|版本)/iu.test(query);
  if (asksAboutModelOrApi && !/(?:官方|官网)/iu.test(query)) {
    const subject = coreSearchSubject(query);
    const apiQuery = subject && trimQuery(`${subject} API`);
    if (apiQuery && !variants.includes(apiQuery)) variants.push(apiQuery);
  }

  return variants.slice(0, 4);
}

export function webSearchNeedsMultipleQueries(query: string): boolean {
  return webSearchQueryBudget(query) > 1;
}

export function webSearchQueryBudget(query: string): number {
  const visualIdentificationQuery = /(?:识别|辨认|这是谁|这是什么|哪个(?:英雄|角色|人物|游戏|设备|型号)|什么(?:英雄|角色|人物|游戏|设备|型号))/iu.test(query);
  if (visualIdentificationQuery) return 3;
  const gameStrategyQuery = /(?:王者荣耀|王者万象棋|万象棋|自走棋|模拟战)/iu.test(query)
    && /(?:怎么玩|怎么打|阵容|阵营|流派|打法|运营|前期|中期|后期)/iu.test(query);
  if (gameStrategyQuery) return 3;
  return DETAIL_TOPIC.test(query) && DETAIL_CUE.test(query) ? 2 : 1;
}

function coreSearchSubject(query: string): string | undefined {
  const subject = normalizeSearchTerms(query
    .replace(/(?:的)?(?:api)?(?:价格|报价|单任务成本|成本|模型能力|能力|上下文|性能|发布情况|定位|新闻|最新消息|信息|细节|详情|详细资料|玩法|怎么玩|怎么打|阵容|阵营|流派|打法|运营|前期|中期|后期|核心机制|角色|职业|攻略|介绍|评价|对比).*$/iu, "")
    .trim());
  return subject ? trimQuery(subject) : undefined;
}

function normalizeSearchTerms(query: string): string {
  return query
    .replace(/deepseek/giu, "DeepSeek")
    .replace(/openai/giu, "OpenAI")
    .replace(/\bglm\b/giu, "GLM")
    .replace(/qwen/giu, "Qwen");
}

export class ZhipuWebSearch {
  private readonly engines: SearchEngine[];

  constructor(private readonly options: WebSearchOptions) {
    this.engines = options.engines?.length
      ? [...new Set(options.engines)]
      : ["search_pro", "search_pro_quark", "search_pro_sogou"];
  }

  async search(
    query: string,
    engine: SearchEngine = this.options.engines?.[0] ?? "search_pro",
    signal?: AbortSignal,
  ): Promise<WebSearchResult[]> {
    const { response, data: result } = await requestJsonObject<ZhipuSearchResponse>(`${this.options.baseUrl}/web_search`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.options.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        search_query: query,
        search_engine: engine,
        search_intent: false,
        count: this.options.count ?? 10,
        search_recency_filter: "noLimit",
        content_size: this.options.contentSize ?? "high",
      }),
    }, { signal, timeoutMs: this.options.timeoutMs, label: "Zhipu Search" });
    if (!response.ok) throw new Error(result.error?.message ?? `联网搜索失败（HTTP ${response.status}）`);
    const results = providerRows<NonNullable<ZhipuSearchResponse["search_result"]>[number]>(result.search_result, "Zhipu Search")
      // The provider may return a useful title/summary while omitting a URL.
      // Do not discard the factual result merely because it is not clickable.
      .filter((item) => typeof item.title === "string" && item.title.trim() && typeof item.content === "string" && item.content.trim())
      .map((item) => ({
        title: item.title!,
        link: typeof item.link === "string" ? item.link : "",
        content: item.content!.slice(0, 12_000),
        media: boundedPageMetadata(item.media, 160),
        publishDate: boundedPageMetadata(item.publish_date, 80),
        searchProviders: ["zhipu" as const],
      }));
    console.log("[web-search] engine=" + engine
      + " results=" + results.length + " query=" + JSON.stringify(query.slice(0, 80)));
    return results;
  }

  async searchWithFallback(query: string, signal?: AbortSignal): Promise<WebSearchResult[]> {
    let lastError: Error | undefined;
    for (const engine of this.engines.slice(0, 3)) {
      signal?.throwIfAborted();
      try {
        const results = await this.search(query, engine, signal);
        signal?.throwIfAborted();
        if (results.length > 0) return results;
      } catch (error) {
        if (signal?.aborted) throw error;
        lastError = error instanceof Error ? error : new Error(String(error));
        console.warn("[web-search] fallback engine=" + engine + " failed: " + lastError.message);
      }
    }
    if (lastError) throw lastError;
    return [];
  }
}

function mergeResults(target: WebSearchResult[], seen: Set<string>, incoming: WebSearchResult[]): void {
  for (const result of incoming) {
    const key = result.link || result.title + "\n" + result.content.slice(0, 160);
    if (seen.has(key)) continue;
    seen.add(key);
    target.push(result);
    if (target.length >= 12) return;
  }
}

interface SearchProvider {
  search(query: string, engine?: SearchEngine, signal?: AbortSignal): Promise<WebSearchResult[]>;
  searchWithFallback?(query: string, signal?: AbortSignal): Promise<WebSearchResult[]>;
}

async function collectWebSearchEvidence(
  request: BrainRequest,
  search: SearchProvider,
  planner?: SearchQueryPlanner,
): Promise<{ request?: BrainRequest; response?: BrainResponse }> {
  const query = await contextualWebSearchQuery(request, planner);
  if (!query) return { request };
  const queries = webSearchQueryVariants(query);
  const attempted: string[] = [];
  const errors: string[] = [];
  const collected: WebSearchResult[] = [];
  const seen = new Set<string>();
  const queryBudget = webSearchQueryBudget(query);
  try {
    for (let index = 0; index < queries.length; index += 1) {
      if (request.signal?.aborted) throw request.signal.reason;
      const candidate = queries[index]!;
      attempted.push(candidate);
      try {
        const results = search.searchWithFallback
          ? await search.searchWithFallback(candidate, request.signal)
          : await search.search(candidate, undefined, request.signal);
        mergeResults(collected, seen, results);
        if (collected.length > 0 && (index + 1 >= queryBudget || index === queries.length - 1)) break;
      } catch (error) {
        if (request.signal?.aborted) throw error;
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }

    if (collected.length > 0) {
      return {
        request: {
          ...request,
          webSearchResults: collected,
          webSearchQueries: attempted,
        },
      };
    }

    if (errors.length === attempted.length) {
      return {
        response: {
          provider: "glm",
          text: `我这次尝试了${attempted.map((item) => `“${item}”`).join("、")}，但联网搜索都没有连上。错误：${errors.at(-1)}`,
        },
      };
    }
    return {
      response: {
        provider: "glm",
        text: `我实际搜索了${attempted.map((item) => `“${item}”`).join("、")}，但都没有拿到可用结果。可以换一组关键词再试。`,
      },
    };
  } catch (error) {
    if (request.signal?.aborted) throw error;
    const reason = error instanceof Error ? error.message : String(error);
    return { response: { provider: "glm", text: `我这次没有连上联网搜索，未把任何网页内容当作结果。错误：${reason}` } };
  }
}

export class WebSearchExtension implements TurnExtension {
  readonly id = "web-search";

  constructor(
    private readonly search: SearchProvider,
    private readonly planner?: SearchQueryPlanner,
  ) {}

  async apply(context: TurnContext): Promise<BrainResponse | undefined> {
    const result = await collectWebSearchEvidence(context.request, this.search, this.planner);
    if (result.request) context.request = result.request;
    return result.response;
  }
}
