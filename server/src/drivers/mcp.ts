import {
  COCKPIT_VERSION,
  type BrainIdentity,
  type McpWhoami,
  type PageDetail,
  type PageSummary,
  type PageVersion,
  type PagesFacets,
  type SearchHit,
  type TakeItem,
  type TakeQuality,
  type WriteReceipt,
  type WriteStatus,
} from "@gbrain-cockpit/shared";

// Minimal MCP driver for the M0 skeleton: initialize handshake + tools/call
// against gbrain serve's Streamable HTTP endpoint, used by /healthz canary
// probes (whoami, get_brain_identity). The full driver (read/write/receipt
// polling, rate-limit budget, caching — ARCHITECTURE §3.1) lands in V1.0; the
// JSON-RPC plumbing here is written to be kept, not thrown away.

export type McpErrorKind =
  | "auth"
  | "rate-limit"
  | "timeout"
  | "http"
  | "protocol"
  | "network";

export class McpError extends Error {
  constructor(
    readonly kind: McpErrorKind,
    message: string,
    readonly status?: number,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "McpError";
  }
}

interface RpcResponse {
  result?: unknown;
  error?: { code: number; message: string };
}

interface ToolCallPayload {
  content?: Array<{ type: string; text?: string }>;
  structuredContent?: unknown;
  isError?: boolean;
}

const PROTOCOL_VERSION = "2025-03-26";

export interface McpDriverOptions {
  url: string;
  token: string;
  /** Driver-layer timeout is the single timeout authority (ARCHITECTURE §6). */
  timeoutMs?: number;
  /** Injectable for tests. */
  fetchFn?: typeof fetch;
}

export class McpDriver {
  readonly #url: string;
  readonly #token: string;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;
  #nextId = 0;
  #sessionId: string | null = null;
  #initPromise: Promise<void> | null = null;

  constructor(opts: McpDriverOptions) {
    this.#url = opts.url;
    this.#token = opts.token;
    this.#timeoutMs = opts.timeoutMs ?? 15_000;
    this.#fetch = opts.fetchFn ?? fetch;
  }

  /** Call an MCP tool and return its parsed payload. */
  async callTool<T = unknown>(
    name: string,
    args: Record<string, unknown> = {},
    opts: { timeoutMs?: number } = {},
  ): Promise<T> {
    await this.#ensureInitialized(opts.timeoutMs);
    const payload = (await this.#rpc("tools/call", {
      name,
      arguments: args,
    }, opts)) as ToolCallPayload | null;
    if (!payload) {
      throw new McpError("protocol", `tools/call ${name} returned no payload`);
    }
    if (payload.isError) {
      const text = payload.content
        ?.map((c) => c.text ?? "")
        .join("\n")
        .trim();
      throw new McpError("protocol", `tool ${name} errored: ${text || "n/a"}`);
    }
    // Prefer the structured payload; fall back to parsing the first text part.
    if (payload.structuredContent !== undefined) {
      return payload.structuredContent as T;
    }
    const text = payload.content?.find((c) => c.type === "text")?.text;
    if (text === undefined) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      return text as T;
    }
  }

  async whoami(): Promise<McpWhoami> {
    return this.callTool<McpWhoami>("whoami");
  }

  async brainIdentity(): Promise<BrainIdentity> {
    return this.callTool<BrainIdentity>("get_brain_identity");
  }

  // --- cached reads ---------------------------------------------------------
  // Process-local TTL cache (ARCHITECTURE §3.1): search 30s, page 10s, list
  // 30s, facets 60s. Keeps cockpit's polite 30 req/min budget alive against
  // UI churn; single-flight merge happens at the route layer via the same
  // cache key, so concurrent identical calls also collapse to one fetch.

  #cache = new Map<string, { at: number; value: unknown }>();

  /** Drop all cached reads — after any successful write or adjudication. */
  invalidateAll(): void {
    this.#cache.clear();
  }

  async #cached<T>(
    ttlMs: number,
    name: string,
    args: Record<string, unknown>,
  ): Promise<T> {
    const key = `${name}:${JSON.stringify(args)}`;
    const hit = this.#cache.get(key);
    if (hit && Date.now() - hit.at < ttlMs) return hit.value as T;
    const value = await this.callTool<T>(name, args);
    this.#cache.set(key, { at: Date.now(), value });
    return value;
  }

  listPages(params: {
    type?: string;
    limit?: number;
    sort?: string;
  }): Promise<PageSummary[]> {
    return this.#cached<PageSummary[]>(30_000, "list_pages", {
      ...(params.type ? { type: params.type } : {}),
      ...(params.limit ? { limit: params.limit } : {}),
      ...(params.sort ? { sort: params.sort } : {}),
    });
  }

  schemaStats(): Promise<PagesFacets> {
    return this.#cached<PagesFacets>(60_000, "schema_stats", {});
  }

  getPage(slug: string): Promise<PageDetail> {
    return this.#cached<PageDetail>(10_000, "get_page", {
      slug,
      include_content: true,
    });
  }

  versions(slug: string): Promise<PageVersion[]> {
    return this.#cached<PageVersion[]>(10_000, "get_versions", { slug });
  }

  search(query: string): Promise<SearchHit[]> {
    return this.#cached<SearchHit[]>(30_000, "search", { query });
  }

  takesList(params: { active?: boolean } = {}): Promise<TakeItem[]> {
    return this.#cached<TakeItem[]>(10_000, "takes_list", { ...params });
  }

  // --- writes (receipt protocol) ---------------------------------------------
  // expected_revision optimistic lock + request_id idempotency; wait_ms 15s
  // (protocol cap 30s). On timeout the write is NOT re-sent — the receipt is
  // polled via getWriteRequest with the same request_id.

  async putPage(params: {
    slug: string;
    content: string;
    expectedRevision: number | string;
    requestId: string;
  }): Promise<WriteReceipt> {
    const result = await this.callTool<Record<string, unknown>>(
      "put_page",
      {
        slug: params.slug,
        content: params.content,
        expected_revision: params.expectedRevision,
        request_id: params.requestId,
        wait_ms: 15_000,
      },
      // wait_ms + RPC overhead headroom, so the fetch timeout never fires
      // before gbrain has had its full wait window.
      { timeoutMs: 20_000 },
    );
    return normalizeReceipt(result, params.requestId);
  }

  async getWriteRequest(requestId: string): Promise<WriteReceipt> {
    const result = await this.callTool<Record<string, unknown>>(
      "get_write_request",
      { request_id: requestId },
    );
    return normalizeReceipt(result, requestId);
  }

  async resolveTake(params: {
    ref: string;
    quality: TakeQuality;
    evidence?: string;
  }): Promise<unknown> {
    return this.callTool("takes_resolve", {
      ref: params.ref,
      quality: params.quality,
      ...(params.evidence ? { evidence: params.evidence } : {}),
    });
  }

  async confirmMemory(params: { ref: string }): Promise<unknown> {
    return this.callTool("confirm_memory", { ref: params.ref });
  }

  async #ensureInitialized(timeoutMs?: number): Promise<void> {
    // Lazily initialize once per session; a failed handshake resets so the
    // next call retries (gbrain restarts shouldn't wedge the driver until
    // process restart).
    this.#initPromise ??= (async () => {
      await this.#rpc(
        "initialize",
        {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "gbrain-cockpit", version: COCKPIT_VERSION },
        },
        { timeoutMs },
      );
      // Notification per spec — no id, no response body expected.
      await this.#post(
        {
          jsonrpc: "2.0",
          method: "notifications/initialized",
        },
        timeoutMs,
      ).catch(() => {
        // Some servers fold this into the session already; a failed
        // notification is not fatal for our single-shot call pattern.
      });
    })();
    try {
      await this.#initPromise;
    } catch (err) {
      this.#initPromise = null;
      // A stale session id is the most common restart artifact — drop it so
      // the retry performs a fresh handshake.
      this.#sessionId = null;
      throw err;
    }
  }

  async #rpc(
    method: string,
    params?: object,
    opts: { timeoutMs?: number } = {},
  ): Promise<unknown> {
    const id = ++this.#nextId;
    const { json } = await this.#post(
      {
        jsonrpc: "2.0",
        id,
        method,
        ...(params ? { params } : {}),
      },
      opts.timeoutMs,
    );
    if (!json) {
      throw new McpError(
        "protocol",
        `no JSON-RPC response for ${method} (HTTP body empty)`,
      );
    }
    if (json.error) {
      throw new McpError(
        "protocol",
        `${method} failed: ${json.error.message} (code ${json.error.code})`,
      );
    }
    return json.result;
  }

  async #post(body: object, timeoutMs?: number): Promise<{ json: RpcResponse | null }> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      // Streamable HTTP servers may answer JSON or SSE per request.
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${this.#token}`,
    };
    if (this.#sessionId) headers["mcp-session-id"] = this.#sessionId;

    let res: Response;
    const effectiveTimeout = timeoutMs ?? this.#timeoutMs;
    try {
      res = await this.#fetch(this.#url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(effectiveTimeout),
      });
    } catch (err) {
      const name = (err as Error)?.name;
      if (name === "TimeoutError" || name === "AbortError") {
        throw new McpError(
          "timeout",
          `MCP request timed out after ${effectiveTimeout}ms (gbrain dreaming? see ARCHITECTURE §3.4)`,
        );
      }
      throw new McpError(
        "network",
        `cannot reach gbrain MCP endpoint: ${(err as Error).message}`,
      );
    }

    if (res.status === 401 || res.status === 403) {
      throw new McpError(
        "auth",
        `gbrain rejected the cockpit token (HTTP ${res.status})`,
        res.status,
      );
    }
    if (res.status === 429) {
      const retryAfter = Number(res.headers.get("retry-after"));
      throw new McpError(
        "rate-limit",
        "gbrain is rate-limiting us (HTTP 429) — respecting Retry-After",
        429,
        Number.isFinite(retryAfter) ? retryAfter * 1000 : undefined,
      );
    }
    if (!res.ok) {
      throw new McpError("http", `unexpected HTTP ${res.status}`, res.status);
    }

    const sessionId = res.headers.get("mcp-session-id");
    if (sessionId) this.#sessionId = sessionId;

    // 202 = notification accepted, no body.
    if (res.status === 202) return { json: null };

    const contentType = res.headers.get("content-type") ?? "";
    const text = await res.text();
    if (contentType.includes("text/event-stream")) {
      return { json: parseSsePayload(text) };
    }
    if (!text) return { json: null };
    try {
      return { json: JSON.parse(text) as RpcResponse };
    } catch {
      throw new McpError(
        "protocol",
        `MCP endpoint returned a non-JSON body (content-type ${contentType || "unknown"})`,
      );
    }
  }
}

/** Extract the JSON-RPC response object from an SSE stream body. */
function parseSsePayload(text: string): RpcResponse | null {
  let last: RpcResponse | null = null;
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data) continue;
    try {
      const parsed = JSON.parse(data) as RpcResponse;
      if ("result" in parsed || "error" in parsed) last = parsed;
    } catch {
      // Keep-alive comments and non-JSON events are skipped.
    }
  }
  return last;
}

const KNOWN_WRITE_STATES: readonly WriteStatus[] = [
  "queued",
  "running",
  "pending",
  "committed",
  "conflict",
  "failed",
  "cancelled",
];

/**
 * Fold whatever a write tool answered into our receipt shape. gbrain's
 * receipt states are queued/running/committed/conflict/failed/cancelled;
 * anything unrecognized becomes "unknown" with the raw payload kept in
 * detail, and a receiptless success reads as committed.
 */
export function normalizeReceipt(
  result: Record<string, unknown> | null | undefined,
  requestId: string,
): WriteReceipt {
  if (result === null || result === undefined) {
    return { request_id: requestId, status: "unknown", detail: "no payload" };
  }
  const raw = (result.write_request ?? result.receipt ?? result) as Record<
    string,
    unknown
  >;
  const status = raw.status;
  const receipt: WriteReceipt = {
    request_id: requestId,
    status:
      typeof status === "string" &&
      (KNOWN_WRITE_STATES as readonly string[]).includes(status)
        ? (status as WriteStatus)
        : "unknown",
  };
  if (receipt.status === "unknown") {
    // A write that returned without a state and without an error: gbrain
    // answered synchronously — treat as committed unless a state arrives.
    const looksImmediate =
      raw.status === undefined &&
      (result.ok === true || result.committed === true || raw.content !== undefined);
    if (looksImmediate) receipt.status = "committed";
    else receipt.detail = JSON.stringify(result).slice(0, 500);
  }
  if (typeof raw.detail === "string") receipt.detail = raw.detail;
  if (typeof raw.retry_after_ms === "number") {
    receipt.retry_after_ms = raw.retry_after_ms;
  }
  return receipt;
}
