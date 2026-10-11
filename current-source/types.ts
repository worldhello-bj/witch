import type { MemoryContext } from "./memory/types.js";

export type BrainProvider = "mock" | "codex" | "glm" | "local";

export type AttachmentKind = "image" | "file" | "video" | "audio";

export interface Attachment {
  kind?: AttachmentKind;
  name?: string;
  mimeType?: string;
  url?: string;
  localPath?: string;
}

export interface IncomingMessage {
  id: string;
  channel: "onebot";
  conversationId: string;
  userId: string;
  text: string;
  attachments: Attachment[];
  raw: unknown;
}

export interface MessageHistoryEntry {
  role: "user" | "assistant";
  source: "qq" | "witch" | "codex-forward";
  text: string;
  timestamp: string;
}

export interface BrainRequest {
  conversationId: string;
  text: string;
  attachments: Attachment[];
  history?: MessageHistoryEntry[];
  memory?: MemoryContext;
  reportProgress?: (text: string) => Promise<void> | void;
  /** Aborted when the owner stops the turn or the runtime shuts down. */
  signal?: AbortSignal;
  webSearchResults?: WebSearchResult[];
  /** Search terms actually submitted to the provider, in execution order. */
  webSearchQueries?: string[];
}

/**
 * Optional routing capability kept separate from Brain: a provider may be
 * able to answer messages without being the model that chooses between chat
 * and Codex delegation.
 */
export interface RouteClassifier {
  classifyRouteIntent(request: BrainRequest, instruction: string): Promise<string>;
}

/** Resolves an underspecified web query from the current message and history. */
export interface SearchQueryPlanner {
  planWebSearchQuery(request: BrainRequest, extractedQuery?: string): Promise<string | undefined>;
  /** Uses attached images plus conversation context to decide whether visual identification needs web grounding. */
  planImageWebSearchQuery?(request: BrainRequest): Promise<string | undefined>;
}

/** Executes one model-authored query; the caller may plan several bounded queries per turn. */
export interface WebSearchExecutor {
  searchWithFallback(
    query: string,
    signal?: AbortSignal,
    context?: WebSearchTaskContext,
  ): Promise<WebSearchResult[]>;
  /** Optionally fetches full page text for a bounded set of already discovered sources. */
  enrichResults?(results: WebSearchResult[], signal?: AbortSignal): Promise<WebSearchResult[]>;
}

/** Minimal, current-turn-only context that can improve a provider's retrieval ranking. */
export interface WebSearchTaskContext {
  requestedPoints: ReadonlyArray<{ id: number; text: string }>;
  responseConstraints: ReadonlyArray<string>;
}

export interface WebSearchResult {
  title: string;
  link: string;
  content: string;
  media?: string;
  publishDate?: string;
  /** Provider/page metadata claim; it is not an authenticated publisher identity. */
  author?: string;
  /** Query lineage for excerpts merged from repeated searches of the same URL. */
  searchExcerpts?: Array<{ query: string; text: string; provider?: "exa" | "brave" | "tavily" | "zhipu" | "baidu" }>;
  /** Search backends that independently returned this page; not a trust rating. */
  searchProviders?: Array<"exa" | "brave" | "tavily" | "zhipu" | "baidu">;
  /** Per-query provider rank; used only for reciprocal-rank fusion, never as authority. */
  searchRanks?: Array<{ query: string; provider: "exa" | "brave" | "tavily" | "zhipu" | "baidu"; rank: number }>;
  /** Full fetched page text is retained for local quote validation, not sent to the answer model. */
  verificationContent?: string;
  fullPageFetched?: boolean;
}

export interface BrainResponse {
  text: string;
  provider: BrainProvider;
  threadId?: string;
  routeLabel?: string;
  status?: "completed" | "needs_confirmation" | "cancelled";
}

export interface Brain {
  reply(request: BrainRequest): Promise<BrainResponse>;

  /** Cancel active provider work for one conversation, when supported. */
  stop?(conversationId: string): Promise<BrainResponse | undefined>;

  /**
   * Handles a deterministic Witch-owned capability before a language model is
   * asked to classify the message.  `undefined` means it was not a native
   * capability request and normal conversation/routing may continue.
   */
  tryHandleNativeCapability?(request: BrainRequest): Promise<BrainResponse | undefined>;

  /** Whether this conversation has an action waiting for the owner's confirmation. */
  hasPendingConfirmation?(conversationId: string): boolean;

  /** Release provider-side resources when the bridge is shutting down. */
  close?(): Promise<void> | void;
}
