import {
  buildGraphKey,
  type GraphEdge,
  type GraphNode,
  type TakeProposal,
} from "@gbrain-cockpit/shared";

// Read-only graph bypass (ARCHITECTURE §3.3, channel ③). The whole SQL
// surface of this driver is the FIXED statements below — identifiers are
// filtered against a hardcoded candidate list via information_schema, so no
// user input can ever reach the database. The DSN must belong to a dedicated
// read-only account; this driver never issues anything but SELECTs and the
// database enforces the rest.
//
// Degrades, never crashes: DSN unset (PGLite engines) → `configured ===
// false` and routes report the channel as down; connection failures → cached
// snapshot + stale marker; nothing here throws at construction time.

/** injected seam for tests (same pattern as McpDriver's fetchFn) */
export type PgQueryFn = (text: string) => Promise<Record<string, unknown>[]>;

export interface GraphSnapshot {
  nodes: GraphNode[];
  edges: GraphEdge[];
  fingerprint: string;
}

export interface GraphResult {
  snapshot: GraphSnapshot;
  /** true when serving the cached graph after a probe/refetch failure */
  stale: boolean;
  error?: string;
}

// --- fixed statements (the ONLY SQL this driver can speak) -------------------

const SQL_PROBE_PAGES =
  "SELECT count(*)::int AS n, coalesce(extract(epoch from max(updated_at))::bigint, -1) AS m FROM pages";
const SQL_PROBE_LINKS = "SELECT count(*)::int AS n FROM links";
const SQL_COLUMNS =
  "SELECT table_name, column_name FROM information_schema.columns " +
  "WHERE table_schema = 'public' AND table_name IN ('pages', 'links')";
/**
 * The Inbox takes queue. NOT reachable through the CLI: gbrain 0.60.558's
 * `takes propose` (list and --accept/--reject alike) scopes to ONE source
 * resolved per run (resolveSourceId, 'default' with no GBRAIN_SOURCE), so
 * on a multi-source brain the CLI only ever shows the default source's
 * proposals — the table read is naturally cross-source. Same column set
 * and newest-first order as upstream's listPendingProposals
 * (src/core/take-proposals.ts), minus its server-side 500-row clamp —
 * the read-only account needs GRANT SELECT on this table (deploy step).
 */
const SQL_TAKES_PENDING =
  "SELECT id, source_id, page_slug, claim_text, kind, holder, weight, domain, status, proposed_at, model_id, promoted_row_num " +
  "FROM take_proposals WHERE status = 'pending' " +
  "ORDER BY proposed_at DESC, id DESC LIMIT 9999";

/**
 * Pages columns we consume; presence-checked against information_schema.
 * `source_id` (gbrain 0.60.558: TEXT NOT NULL DEFAULT 'default', with
 * UNIQUE(source_id, slug)) upgrades node identity from bare slug to
 * `source_id/slug` — its absence (older brains) degrades to slug keys,
 * where upstream's global slug uniqueness then holds.
 */
const PAGES_WANT = ["id", "slug", "title", "type", "updated_at", "source_id"] as const;
/** candidate endpoint column pairs for links, most likely first */
const LINK_ENDPOINT_PAIRS: readonly (readonly [string, string])[] = [
  // live-probed gbrain 0.60.558 shape (integer FKs into pages.id)
  ["from_page_id", "to_page_id"],
  ["from", "to"],
  ["from_slug", "to_slug"],
  ["source", "target"],
  ["source_slug", "target_slug"],
  ["from_id", "to_id"],
  ["source_id", "target_id"],
];
const LINK_EXTRA_WANT = ["link_type", "link_source"] as const;

const TTL_MS = 15 * 60 * 1000; // freshness backstop (dream edits edges nightly)
const QUERY_TIMEOUT_MS = 10_000;

/** normalize a pg timestamp (Date or string) to epoch seconds, or null */
function toEpochSeconds(value: unknown): number | null {
  if (value instanceof Date) return Math.floor(value.getTime() / 1000);
  if (typeof value === "string" && value) {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : Math.floor(parsed / 1000);
  }
  if (typeof value === "number" && Number.isFinite(value)) return Math.floor(value / 1000);
  return null;
}

function makeBunQuery(dsn: string): PgQueryFn {
  // Bun's built-in Postgres client keeps the server at zero runtime npm deps
  // (ARCHITECTURE §8). One pool per process; `unsafe` is fine because every
  // statement here is a module-level constant with zero interpolation.
  // (The cast only bridges a construct-signature gap in @types/bun; the
  // runtime shape — `new Bun.sql(dsn)` returning a queryable — is stable.)
  const SqlClient = Bun.sql as unknown as new (dsn: string) => {
    unsafe(text: string): Promise<unknown>;
  };
  const sql = new SqlClient(dsn);
  return async (text) => {
    const result = (await Promise.race([
      sql.unsafe(text),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("pg query timeout")), QUERY_TIMEOUT_MS),
      ),
    ])) as unknown;
    if (Array.isArray(result)) return result as Record<string, unknown>[];
    const rows = (result as { rows?: unknown })?.rows;
    return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
  };
}

export class PgReadonlyDriver {
  readonly configured: boolean;
  readonly #dsn: string | null;
  readonly #query: PgQueryFn;
  #columns: Map<string, Set<string>> | null = null;
  #cache: { snapshot: GraphSnapshot; at: number } | null = null;
  #inflight: Promise<GraphResult> | null = null;

  constructor(opts: { dsn: string | null; query?: PgQueryFn }) {
    this.#dsn = opts.dsn;
    this.configured = opts.dsn !== null;
    this.#query = opts.query ?? makeBunQuery(opts.dsn ?? "");
  }

  /** liveness probe for /healthz — reuses the fixed pages probe statement */
  async ping(): Promise<number> {
    const started = performance.now();
    await this.#query(SQL_PROBE_PAGES);
    return Math.round(performance.now() - started);
  }

  /**
   * The Inbox takes queue — fresh every call, deliberately uncached:
   * adjudications flip rows to accepted/rejected and the queue must reflect
   * them on the next poll (the graph's TTL pattern would serve stale
   * verdicts). Numeric coercion mirrors upstream's normalizeTakeProposalRow
   * so CLI-shaped consumers see the same contract.
   */
  async pendingTakeProposals(): Promise<TakeProposal[]> {
    if (!this.configured) {
      throw new Error("read-only bypass not configured (PG_READONLY_DSN unset)");
    }
    const rows = await this.#query(SQL_TAKES_PENDING);
    return rows.map((row) => {
      const proposal: TakeProposal = {
        id: Number(row.id),
        page_slug: String(row.page_slug ?? ""),
        claim_text: String(row.claim_text ?? ""),
        ...(typeof row.source_id === "string" ? { source_id: row.source_id } : {}),
        ...(typeof row.kind === "string" ? { kind: row.kind } : {}),
        ...(typeof row.holder === "string" ? { holder: row.holder } : {}),
        ...(row.weight === undefined || row.weight === null
          ? {}
          : { weight: Number(row.weight) }),
        ...(typeof row.domain === "string" && row.domain
          ? { domain: row.domain }
          : {}),
        ...(typeof row.status === "string" ? { status: row.status } : {}),
        ...(row.proposed_at instanceof Date
          ? { proposed_at: row.proposed_at.toISOString() }
          : typeof row.proposed_at === "string" && row.proposed_at
            ? { proposed_at: row.proposed_at }
            : {}),
        ...(typeof row.model_id === "string" && row.model_id
          ? { model_id: row.model_id }
          : {}),
        ...(row.promoted_row_num === undefined || row.promoted_row_num === null
          ? {}
          : { promoted_row_num: Number(row.promoted_row_num) }),
      };
      return proposal;
    });
  }

  /**
   * Whole-brain snapshot with process-local caching and single-flight
   * merging. Probe = two tiny fixed counts; the full SELECT reruns only when
   * the fingerprint changes or the TTL expires. Known limit (documented in
   * ARCHITECTURE §3.3): links carry no timestamps, so a same-count rewire is
   * invisible to the probe and rides the 15-minute TTL backstop.
   */
  async getGraph(): Promise<GraphResult> {
    if (!this.configured) {
      throw new Error("read-only bypass not configured (PG_READONLY_DSN unset)");
    }
    if (this.#inflight) return this.#inflight;
    this.#inflight = this.#load();
    try {
      return await this.#inflight;
    } finally {
      this.#inflight = null;
    }
  }

  async #load(): Promise<GraphResult> {
    const cache = this.#cache;
    const age = cache ? Date.now() - cache.at : Infinity;

    let probeFp: string | null = null;
    let probeOk = true;
    try {
      probeFp = await this.#probeFingerprint();
    } catch {
      probeOk = false;
    }

    if (cache && probeOk && probeFp === cache.snapshot.fingerprint && age < TTL_MS) {
      return { snapshot: cache.snapshot, stale: false };
    }

    try {
      const snapshot = await this.#fullLoad();
      this.#cache = { snapshot, at: Date.now() };
      return { snapshot, stale: false };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (cache) return { snapshot: cache.snapshot, stale: true, error: message };
      throw err;
    }
  }

  async #probeFingerprint(): Promise<string> {
    const [pages, links] = await Promise.all([
      this.#query(SQL_PROBE_PAGES),
      this.#query(SQL_PROBE_LINKS),
    ]);
    // The "s" schema marker (source column present) must appear in BOTH the
    // probe and the snapshot fingerprint or the two formats never compare
    // equal and every TTL cycle would full-load. The column map is cached
    // from the first full load; before that there is no cache to compare.
    const s = this.#columns?.get("pages")?.has("source_id") ? "s" : "";
    return `p${String(pages[0]?.n ?? "?")}${s}/${String(pages[0]?.m ?? "?")}/l${String(links[0]?.n ?? "?")}`;
  }

  async #ensureColumns(): Promise<Map<string, Set<string>>> {
    if (this.#columns) return this.#columns;
    const rows = await this.#query(SQL_COLUMNS);
    const map = new Map<string, Set<string>>([
      ["pages", new Set()],
      ["links", new Set()],
    ]);
    for (const row of rows) {
      const table = String(row.table_name ?? "");
      const column = String(row.column_name ?? "");
      map.get(table)?.add(column);
    }
    const pages = map.get("pages");
    if (!pages?.has("slug")) {
      throw new Error("pages table has no `slug` column — read-only bypass cannot map the graph");
    }
    this.#columns = map;
    return map;
  }

  async #fullLoad(): Promise<GraphSnapshot> {
    const columns = await this.#ensureColumns();
    const pagesCols = [...PAGES_WANT].filter((c) => columns.get("pages")?.has(c));
    const linksCols = columns.get("links");
    const pair =
      LINK_ENDPOINT_PAIRS.find(
        ([a, b]) => linksCols?.has(a) && linksCols?.has(b),
      ) ?? null;
    if (!pair) {
      throw new Error("links table has no recognized endpoint column pair");
    }
    const linkCols = [pair[0], pair[1], ...LINK_EXTRA_WANT.filter((c) => linksCols?.has(c))];

    const sqlPages = `SELECT ${pagesCols.join(", ")} FROM pages`;
    const sqlLinks = `SELECT ${linkCols.map((c) => `"${c}"`).join(", ")} FROM links`;

    const [pagesRows, linksRows] = await Promise.all([
      this.#query(sqlPages),
      this.#query(sqlLinks),
    ]);

    // Node identity is (source_id, slug) when the source column exists:
    // keys are `source_id/slug` (buildGraphKey). Endpoints resolve through
    // the id→key map; a value that already IS a slug passes through ONLY
    // when that slug is unique across sources — an ambiguous slug endpoint
    // names no single page, so the edge drops (visible degradation, never a
    // silent wrong-node link).
    const hasSource = pagesCols.includes("source_id");
    const idToKey = new Map<string, string>();
    const slugCount = new Map<string, number>();
    const slugToKey = new Map<string, string>();
    for (const row of pagesRows) {
      const slug = String(row.slug ?? "");
      if (!slug) continue;
      const sourceId =
        hasSource && typeof row.source_id === "string" && row.source_id
          ? row.source_id
          : undefined;
      const key = buildGraphKey(sourceId, slug);
      slugCount.set(slug, (slugCount.get(slug) ?? 0) + 1);
      slugToKey.set(slug, key);
      const id = row.id;
      if (id !== undefined && id !== null) idToKey.set(String(id), key);
    }
    const resolve = (value: unknown): string | null => {
      const raw = value === undefined || value === null ? "" : String(value);
      if (!raw) return null;
      if (idToKey.has(raw)) return idToKey.get(raw)!;
      if (slugCount.get(raw) === 1) return slugToKey.get(raw)!;
      return null;
    };

    const degree = new Map<string, number>();
    const edges: GraphEdge[] = [];
    for (const row of linksRows) {
      const source = resolve(row[pair[0]]);
      const target = resolve(row[pair[1]]);
      if (!source || !target || source === target) continue;
      const edge: GraphEdge = { source, target };
      const type = row.link_type;
      const origin = row.link_source;
      if (typeof type === "string" && type) edge.link_type = type;
      if (typeof origin === "string" && origin) edge.link_source = origin;
      edges.push(edge);
      degree.set(source, (degree.get(source) ?? 0) + 1);
      degree.set(target, (degree.get(target) ?? 0) + 1);
    }

    const nodes: GraphNode[] = [];
    const emitted = new Set<string>();
    // epoch seconds, matching the probe's extract(epoch …) so both sides of
    // the fingerprint comparison speak the same unit regardless of how the
    // driver serializes timestamptz values
    let maxUpdatedEpoch = -1;
    for (const row of pagesRows) {
      const slug = String(row.slug ?? "");
      if (!slug) continue;
      const sourceId =
        hasSource && typeof row.source_id === "string" && row.source_id
          ? row.source_id
          : undefined;
      const key = buildGraphKey(sourceId, slug);
      if (emitted.has(key)) continue; // defensive: identity is unique per schema
      emitted.add(key);
      const node: GraphNode = {
        key,
        slug,
        degree: degree.get(key) ?? 0,
        ...(sourceId ? { source_id: sourceId } : {}),
      };
      if (typeof row.title === "string" && row.title) node.title = row.title;
      if (typeof row.type === "string" && row.type) node.type = row.type;
      const updated = row.updated_at;
      const epoch = toEpochSeconds(updated);
      if (epoch !== null) {
        node.updated_at =
          updated instanceof Date
            ? updated.toISOString()
            : String(updated);
        if (epoch > maxUpdatedEpoch) maxUpdatedEpoch = epoch;
      }
      nodes.push(node);
    }

    // The trailing schema marker ("s" = source column present) renames every
    // node key, so it must invalidate clients' frozen layouts exactly once.
    return {
      nodes,
      edges,
      fingerprint: `p${nodes.length}${hasSource ? "s" : ""}/${maxUpdatedEpoch}/l${edges.length}`,
    };
  }
}
