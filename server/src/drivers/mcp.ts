import {
  COCKPIT_VERSION,
  type BrainIdentity,
  type ContradictionProbeState,
  type EvidencePayload,
  type LinkRow,
  type McpWhoami,
  type PageDetail,
  type PageSummary,
  type PageVersion,
  type PagesFacets,
  type SearchHit,
  type SourceDiagnostic,
  type SourceSummary,
  type TakeItem,
  type TakeQuality,
  type TimelineEntry,
  type WriteConflictRow,
  type WriteReceipt,
  type WriteRequestRow,
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
  | "network"
  /**
   * gbrain's opError 'permission_denied' / 'insufficient_scope' — the grant
   * refuses this call (e.g. a source outside federated_read). Distinct from
   * "auth" (HTTP 401/403) so the web can explain it in user language.
   */
  | "denied"
  /** gbrain's opError 'unknown_source' — the named source no longer exists. */
  | "unknown-source";

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

/**
 * A parsed `gbrain mcp grant --credentials-out` handoff (OAuth
 * client_credentials). The access token it ships expires (typically 3600s
 * for renewable harnesses); the driver renews it itself via a form POST to
 * `${issuerUrl}/token` — mirroring upstream's credentialAccessToken(). The
 * secret lives in memory only and never reaches a log or an error message.
 */
export interface OAuthHandoff {
  issuerUrl: string;
  clientId: string;
  clientSecret: string;
  accessToken?: string;
  /** epoch seconds */
  expiresAt?: number;
}

export interface McpDriverOptions {
  url: string;
  /** static bearer token (legacy `gbrain auth create`) — required unless oauth */
  token?: string;
  /** OAuth handoff — when set, token renewal is the driver's job */
  oauth?: OAuthHandoff;
  /** Driver-layer timeout is the single timeout authority (ARCHITECTURE §6). */
  timeoutMs?: number;
  /** Injectable for tests. */
  fetchFn?: typeof fetch;
}

export class McpDriver {
  readonly #url: string;
  readonly #staticToken: string;
  readonly #oauth: OAuthHandoff | null;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;
  #nextId = 0;
  #sessionId: string | null = null;
  #initPromise: Promise<void> | null = null;
  #accessToken: string | null = null;
  #accessTokenExpiresAt: number | undefined = undefined;
  #renewPromise: Promise<void> | null = null;

  constructor(opts: McpDriverOptions) {
    this.#url = opts.url;
    this.#staticToken = opts.token ?? "";
    this.#oauth = opts.oauth ?? null;
    if (!this.#oauth && !this.#staticToken) {
      throw new McpError("auth", "McpDriver needs a token or an oauth handoff");
    }
    if (this.#oauth) {
      this.#accessToken = this.#oauth.accessToken ?? null;
      this.#accessTokenExpiresAt = this.#oauth.expiresAt;
    }
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
      const text =
        payload.content
          ?.map((c) => c.text ?? "")
          .join("\n")
          .trim() ?? "";
      // gbrain opErrors arrive as one JSON content block: {error, code,
      // message, suggestion, …} (agent contract v1, verified 0.60.558).
      // Classify the two scope-related codes so routes can answer in user
      // language instead of a bare 502; everything else stays protocol.
      const envelope = parseErrorEnvelope(text);
      if (envelope) {
        const code = envelope.code ?? envelope.error ?? "";
        const message = envelope.message ?? text;
        if (code === "permission_denied" || code === "insufficient_scope") {
          throw new McpError("denied", message);
        }
        if (code === "unknown_source") {
          throw new McpError("unknown-source", message);
        }
      }
      throw new McpError("protocol", `tool ${name} errored: ${text || "n/a"}`);
    }
    // Prefer the structured payload; fall back to parsing the first text part.
    // `_meta` (upstream's behavior-disclosure notices, hundreds of chars per
    // call) is stripped HERE — the single choke point — and its
    // gbrain_notices texts kept for Health; business rendering never sees it.
    if (payload.structuredContent !== undefined) {
      this.#harvestNotices(payload.structuredContent);
      if (payload.structuredContent !== null &&
        typeof payload.structuredContent === "object" &&
        !Array.isArray(payload.structuredContent) &&
        "_meta" in (payload.structuredContent as Record<string, unknown>)) {
        const clean = { ...(payload.structuredContent as Record<string, unknown>) };
        delete clean._meta;
        return clean as T;
      }
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

  async whoami(
    opts: { timeoutMs?: number } = {},
  ): Promise<McpWhoami> {
    return this.callTool<McpWhoami>("whoami", {}, opts);
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
  /** single-flight: same-key reads in flight share ONE upstream call (the
   *  doc above promised this from day one; graph lazy-loads and rapid tab
   *  switches made the promise load-bearing) */
  #inflight = new Map<string, Promise<unknown>>();
  /** latest _meta.gbrain_notices texts (ring, newest last) — Health surfaces them */
  #notices: string[] = [];

  /** Drop all cached reads — after any successful write or adjudication. */
  invalidateAll(): void {
    this.#cache.clear();
  }

  /**
   * 0.4.0 ops: force-discard the cached OAuth access token and mint a fresh
   * one now. Called after `auth rescope` — the widened federated_read only
   * exists on tokens minted AFTER the grant change, and without this the
   * drift card would stay red (honestly wrong) until natural expiry.
   * No-op for static-token profiles.
   */
  async forceRenew(): Promise<void> {
    await this.#ensureRenewed(true);
  }

  /** The latest upstream behavior-disclosure notices (ARCHITECTURE §7). */
  get lastNotices(): readonly string[] {
    return this.#notices;
  }

  async #cached<T>(
    ttlMs: number,
    name: string,
    args: Record<string, unknown>,
  ): Promise<T> {
    const key = `${name}:${JSON.stringify(args)}`;
    const hit = this.#cache.get(key);
    if (hit && Date.now() - hit.at < ttlMs) return hit.value as T;
    const existing = this.#inflight.get(key);
    if (existing) return existing as Promise<T>;
    const flight = (async () => {
      try {
        const value = await this.callTool<T>(name, args);
        this.#cache.set(key, { at: Date.now(), value });
        return value;
      } finally {
        this.#inflight.delete(key);
      }
    })();
    this.#inflight.set(key, flight);
    return flight;
  }

  listPages(params: {
    type?: string;
    limit?: number;
    sort?: string;
    /**
     * Deep paging — probed 0.60.558: offset windows are strictly descending,
     * non-overlapping and repeat-stable. Attached only when > 0 so first
     * pages stay byte-identical for older gbrains.
     */
    offset?: number;
    /**
     * Keyset cursor pair, documented by list_pages itself — but on the
     * probed 0.60.558 remote these act as an ascending "newer-than" window
     * filter (sort ignored), NOT a cursor. Kept wired for future builds;
     * cockpit's own paging uses `offset` (see probe-keyset.ts).
     */
    updatedAfter?: string;
    updatedAfterSlug?: string;
    /**
     * Literal slug prefix ("deals/" style — documented + probed 0.60.558):
     * the slug dimension's server-side narrowing.
     */
    slugPrefix?: string;
    /**
     * Tag filter (documented via add_tag's description; param probed and
     * accepted by list_pages on 0.60.558 — the probed brain simply has no
     * tagged pages yet, hence empty results there).
     */
    tag?: string;
    /**
     * Narrow to one source (list_pages accepts source_id/source_ids on
     * 0.60.558 — narrow-only against the grant). Attached ONLY when the
     * caller explicitly picked a source, so unfiltered traffic stays
     * byte-identical for older gbrain versions.
     */
    sourceId?: string;
  }): Promise<PageSummary[]> {
    return this.#cached<PageSummary[]>(30_000, "list_pages", {
      ...(params.type ? { type: params.type } : {}),
      ...(params.limit ? { limit: params.limit } : {}),
      ...(params.sort ? { sort: params.sort } : {}),
      ...(params.offset ? { offset: params.offset } : {}),
      ...(params.updatedAfter ? { updated_after: params.updatedAfter } : {}),
      ...(params.updatedAfterSlug
        ? { updated_after_slug: params.updatedAfterSlug }
        : {}),
      ...(params.slugPrefix ? { slug_prefix: params.slugPrefix } : {}),
      ...(params.tag ? { tag: params.tag } : {}),
      ...(params.sourceId ? { source_id: params.sourceId } : {}),
    });
  }

  schemaStats(): Promise<PagesFacets> {
    return this.#cached<PagesFacets>(60_000, "schema_stats", {});
  }

  /**
   * Page identity is (source_id, slug): a bare slug with same-slug pages in
   * two sources is resolved server-side by source_id ASC LIMIT 1 — SILENTLY
   * (verified 0.60.558). Pass sourceId whenever the caller knows it.
   */
  getPage(slug: string, sourceId?: string): Promise<PageDetail> {
    return this.#cached<PageDetail>(10_000, "get_page", {
      slug,
      include_content: true,
      ...(sourceId ? { source_id: sourceId } : {}),
    });
  }

  versions(slug: string): Promise<PageVersion[]> {
    // NOTE: get_versions' source_id only pairs with known_as_of upstream —
    // never send it bare (invalid_params). Version history follows the
    // bare-slug resolution; the drawer flags that when siblings exist.
    return this.#cached<PageVersion[]>(10_000, "get_versions", { slug });
  }

  search(query: string, sourceId?: string): Promise<SearchHit[]> {
    return this.#cached<SearchHit[]>(30_000, "search", {
      query,
      ...(sourceId ? { source_id: sourceId } : {}),
    });
  }

  /**
   * Registered sources with page counts (grant-scoped upstream — the list
   * carries no "rows withheld" marker, so the UI must not present it as
   * "every source in this brain").
   */
  async sourcesList(): Promise<SourceSummary[]> {
    const result = await this.#cached<{ sources?: unknown }>(
      60_000,
      "sources_list",
      {},
    );
    const raw = result?.sources;
    if (!Array.isArray(raw)) return [];
    return raw.filter(
      (s): s is SourceSummary =>
        s !== null && typeof s === "object" && typeof (s as SourceSummary).id === "string",
    );
  }

  takesList(params: { active?: boolean } = {}): Promise<TakeItem[]> {
    return this.#cached<TakeItem[]>(10_000, "takes_list", { ...params });
  }

  /**
   * The contradiction probe's latest run (feeds the Inbox contradiction lane's
   * informational header). Probed 0.60.611, two shapes: never ran →
   * `{contradictions: [], note: "No probe runs in the last 30 days; …"}`;
   * ran → `{run_id, ran_at, contradictions: […], total_visible}`. 60s TTL —
   * it changes only when someone runs the probe.
   */
  findContradictions(): Promise<ContradictionProbeState> {
    return this.#cached<ContradictionProbeState>(60_000, "find_contradictions", {});
  }

  #harvestNotices(value: unknown): void {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return;
    const meta = (value as Record<string, unknown>)._meta;
    if (meta === null || typeof meta !== "object" || Array.isArray(meta)) return;
    const notices = (meta as Record<string, unknown>).gbrain_notices;
    if (!Array.isArray(notices)) return;
    for (const n of notices) {
      if (typeof n === "string" && n.trim()) {
        this.#notices.push(n.trim().slice(0, 400));
      }
    }
    if (this.#notices.length > 5) this.#notices = this.#notices.slice(-5);
  }

  /**
   * The extraction queue's three lists (0.60.578+): pending stubs (the
   * reviewable lane), unattributed facts and possible duplicates. Read-only —
   * the dispose verb (extraction_review) is owner-only upstream.
   */
  extractionPending(): Promise<{
    count?: number;
    pending?: unknown[];
    unattributed?: { count?: number; rows?: unknown[] };
    possible_duplicates?: { count?: number; rows?: unknown[] };
    [k: string]: unknown;
  }> {
    return this.#cached(30_000, "extraction_pending", {
      include: ["pending", "unattributed", "possible_duplicates"],
    });
  }

  /**
   * The semantic half of the search dual entry (MCP `query` — the argument is
   * literally `query`, probed; it also accepts `image`, left to V2.5).
   * Response shape varies; normalized to a SearchHit[] by the route.
   */
  query(q: string, sourceId?: string): Promise<unknown> {
    return this.#cached(30_000, "query", {
      query: q,
      ...(sourceId ? { source_id: sourceId } : {}),
    });
  }

  /** Fuzzy slug/title → exact slugs (the jump box's resolver). */
  resolveSlugs(partial: string, sourceId?: string): Promise<string[]> {
    return this.#cached<string[]>(30_000, "resolve_slugs", {
      partial,
      ...(sourceId ? { source_id: sourceId } : {}),
    });
  }

  /** gbrain's own health bands (write capacity, ghost pages, …). */
  brainHealth(): Promise<Record<string, unknown>> {
    return this.#cached<Record<string, unknown>>(30_000, "get_brain_health", {});
  }

  /** Per-cohort statistical anomalies (probed: [] on a young brain). */
  anomalies(): Promise<unknown[]> {
    const call = this.#cached<{ anomalies?: unknown[] } | unknown[]>(
      60_000,
      "find_anomalies",
      {},
    );
    return call.then((r) => (Array.isArray(r) ? r : r?.anomalies ?? []));
  }

  /** Cancel THIS token's accepted-but-unpublished write (gbrain's own guard). */
  async cancelWriteRequest(requestId: string): Promise<WriteReceipt> {
    const receipt = await this.callTool<WriteReceipt>("cancel_write_request", {
      request_id: requestId,
    });
    if (receipt?.status === "cancelled") this.invalidateAll();
    return receipt;
  }

  /**
   * Judge an ACTIVE take (the propose→accept→witness→resolve loop's last
   * step). gbrain stamps the resolver `mcp:<client>` — a feature: owner
   * verdicts and cockpit verdicts stay distinguishable forever.
   */
  async takesResolve(
    slug: string,
    rowNum: number,
    quality: TakeQuality,
  ): Promise<unknown> {
    const result = await this.callTool<unknown>("takes_resolve", {
      slug,
      row: rowNum,
      quality,
    });
    this.invalidateAll();
    return result;
  }

  // --- V1.1 dimensions & provenance (live-probed 0.60.558, 2026-11-06) --------
  // Probe snapshots: internal/probes/mcp-probe-v1.1*.json. All read-only.

  /**
   * A page's outgoing edges. Rows carry BOTH endpoints' full identity plus a
   * context excerpt and the edge's provenance. The same from→to pair may
   * appear once per link_source (e.g. markdown AND mcp-remote-mention) — that
   * is the data, not a bug; the UI shows rows as-is with the provenance badge.
   */
  getLinks(slug: string, sourceId?: string): Promise<LinkRow[]> {
    return this.#cached<LinkRow[]>(10_000, "get_links", {
      slug,
      ...(sourceId ? { source_id: sourceId } : {}),
    });
  }

  /** A page's incoming edges (referrer = the from_* side), ≤500/call. */
  getBacklinks(slug: string, sourceId?: string): Promise<LinkRow[]> {
    return this.#cached<LinkRow[]>(10_000, "get_backlinks", {
      slug,
      ...(sourceId ? { source_id: sourceId } : {}),
    });
  }

  /** Read-only timeline entries (pages without a Timeline section answer []). */
  getTimeline(slug: string): Promise<TimelineEntry[]> {
    return this.#cached<TimelineEntry[]>(10_000, "get_timeline", { slug });
  }

  /**
   * The token's own write receipts in one source, newest first — the
   * gbrain-side truth behind write-receipt transparency. 10s cache: pure
   * browsing dedupe; receipts are history, so a short cache never lies.
   */
  async listWriteRequests(
    params: { sourceId?: string; limit?: number } = {},
  ): Promise<WriteRequestRow[]> {
    const result = await this.#cached<{ requests?: unknown }>(
      10_000,
      "list_write_requests",
      {
        ...(params.sourceId ? { source_id: params.sourceId } : {}),
        ...(params.limit ? { limit: params.limit } : {}),
      },
    );
    const raw = result?.requests;
    if (!Array.isArray(raw)) return [];
    return raw.filter(
      (r): r is WriteRequestRow => r !== null && typeof r === "object",
    );
  }

  /** Pages whose writes keep ending in a source_changed conflict, by slug. */
  async listWriteConflicts(
    params: { sourceId?: string } = {},
  ): Promise<WriteConflictRow[]> {
    const result = await this.#cached<{ conflicts?: unknown }>(
      30_000,
      "list_write_conflicts",
      {
        ...(params.sourceId ? { source_id: params.sourceId } : {}),
      },
    );
    const raw = result?.conflicts;
    if (!Array.isArray(raw)) return [];
    return raw.filter(
      (r): r is WriteConflictRow => r !== null && typeof r === "object",
    );
  }

  /**
   * Per-source diagnostic. NOTE: the upstream argument is `id`, NOT source_id
   * (probed — an empty/source_id call answers invalid_params).
   */
  sourcesStatus(sourceId: string): Promise<SourceDiagnostic> {
    return this.#cached<SourceDiagnostic>(60_000, "sources_status", {
      id: sourceId,
    });
  }

  /**
   * Whole evidence for prior search hits — {source_id, slug, chunk_id}
   * triples, chunk_id is a NUMBER. return_unit "window" delivers ~2× the
   * search snippet around the hit (probed).
   */
  assembleEvidence(
    hits: Array<{ sourceId: string; slug: string; chunkId: number }>,
    opts: { returnUnit?: string } = {},
  ): Promise<EvidencePayload> {
    return this.#cached<EvidencePayload>(30_000, "assemble_evidence", {
      hits: hits.map((h) => ({
        source_id: h.sourceId,
        slug: h.slug,
        chunk_id: h.chunkId,
      })),
      ...(opts.returnUnit ? { return_unit: opts.returnUnit } : {}),
    });
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
    const attempt = async (): Promise<unknown> => {
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
    };
    try {
      return await attempt();
    } catch (err) {
      // OAuth access tokens expire mid-session: one forced renewal and a
      // single replay. Static tokens never take this path.
      if (
        err instanceof McpError &&
        err.kind === "auth" &&
        this.#oauth !== null
      ) {
        await this.#ensureRenewed(true);
        this.#sessionId = null; // the server may have dropped the session
        return await attempt();
      }
      throw err;
    }
  }

  /** The bearer for the next request; renews proactively when expired. */
  async #bearerToken(): Promise<string> {
    if (this.#oauth === null) return this.#staticToken;
    const now = Date.now() / 1000;
    const valid =
      this.#accessToken !== null &&
      (this.#accessTokenExpiresAt === undefined ||
        this.#accessTokenExpiresAt > now + 30);
    if (!valid) await this.#ensureRenewed();
    return this.#accessToken!;
  }

  /** Single-flight client_credentials renewal against ${issuerUrl}/token. */
  async #ensureRenewed(force = false): Promise<void> {
    if (force) this.#accessToken = null;
    this.#renewPromise ??= this.#renew().finally(() => {
      this.#renewPromise = null;
    });
    return this.#renewPromise;
  }

  async #renew(): Promise<void> {
    const oauth = this.#oauth;
    if (oauth === null) return;
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: oauth.clientId,
      client_secret: oauth.clientSecret,
    });
    let res: Response;
    try {
      res = await this.#fetch(`${oauth.issuerUrl}/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: body.toString(),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (err) {
      const name = (err as Error)?.name;
      if (name === "TimeoutError" || name === "AbortError") {
        throw new McpError(
          "timeout",
          `OAuth token renewal timed out after ${this.#timeoutMs}ms`,
        );
      }
      throw new McpError(
        "network",
        `cannot reach the OAuth token endpoint: ${(err as Error).message}`,
      );
    }
    if (res.status === 429) {
      const retryAfter = Number(res.headers.get("retry-after"));
      throw new McpError(
        "rate-limit",
        "OAuth token endpoint is rate-limiting us (HTTP 429) — respecting Retry-After",
        429,
        Number.isFinite(retryAfter) ? retryAfter * 1000 : undefined,
      );
    }
    if (!res.ok) {
      // Never echo the response body: it can reflect credentials back.
      throw new McpError(
        "auth",
        `OAuth token renewal failed (HTTP ${res.status})`,
      );
    }
    const json = (await res.json().catch(() => null)) as {
      access_token?: unknown;
      expires_in?: unknown;
    } | null;
    if (!json || typeof json.access_token !== "string" || !json.access_token) {
      throw new McpError(
        "auth",
        "OAuth token endpoint returned no access_token",
      );
    }
    this.#accessToken = json.access_token;
    this.#accessTokenExpiresAt =
      typeof json.expires_in === "number" && Number.isFinite(json.expires_in)
        ? Date.now() / 1000 + json.expires_in
        : undefined;
  }

  async #post(body: object, timeoutMs?: number): Promise<{ json: RpcResponse | null }> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      // Streamable HTTP servers may answer JSON or SSE per request.
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${await this.#bearerToken()}`,
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

/** Parse a gbrain agent-contract error envelope from a tool-error text block. */
function parseErrorEnvelope(
  text: string,
): { error?: string; code?: string; message?: string } | null {
  if (!text.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    if (typeof parsed.error !== "string" && typeof parsed.code !== "string") {
      return null;
    }
    return {
      ...(typeof parsed.error === "string" ? { error: parsed.error } : {}),
      ...(typeof parsed.code === "string" ? { code: parsed.code } : {}),
      ...(typeof parsed.message === "string" ? { message: parsed.message } : {}),
    };
  } catch {
    return null;
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
