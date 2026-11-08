import { describe, expect, test } from "bun:test";
import { PgReadonlyDriver, type PgQueryFn } from "./pg-readonly";

// The bypass is tested through the injected query seam (same pattern as
// McpDriver's fetchFn): no real database, scripted responses per statement.

interface Script {
  text: string;
  rows: Record<string, unknown>[];
}

function makeQuery(scripts: Script[], log: string[] = []): PgQueryFn {
  return async (text) => {
    log.push(text);
    const hit = scripts.find((s) => s.text === text);
    if (!hit) throw new Error(`unexpected query: ${text}`);
    return hit.rows;
  };
}

const COLUMNS: Script = {
  text:
    "SELECT table_name, column_name FROM information_schema.columns " +
    "WHERE table_schema = 'public' AND table_name IN ('pages', 'links')",
  rows: [
    { table_name: "pages", column_name: "id" },
    { table_name: "pages", column_name: "slug" },
    { table_name: "pages", column_name: "title" },
    { table_name: "pages", column_name: "type" },
    { table_name: "pages", column_name: "updated_at" },
    { table_name: "links", column_name: "from" },
    { table_name: "links", column_name: "to" },
    { table_name: "links", column_name: "link_type" },
    { table_name: "links", column_name: "link_source" },
  ],
};

const SQL_PROBE_PAGES =
  "SELECT count(*)::int AS n, coalesce(extract(epoch from max(updated_at))::bigint, -1) AS m FROM pages";
const SQL_PROBE_LINKS = "SELECT count(*)::int AS n FROM links";
const SQL_LINKS = 'SELECT "from", "to", "link_type", "link_source" FROM links';

describe("PgReadonlyDriver", () => {
  test("unconfigured DSN reports not configured and never queries", async () => {
    const log: string[] = [];
    const driver = new PgReadonlyDriver({ dsn: null, query: makeQuery([], log) });
    expect(driver.configured).toBe(false);
    // getGraph on an unconfigured driver throws (route reports "down")
    await expect(driver.getGraph()).rejects.toThrow();
    expect(log.length).toBe(0);
  });

  test("resolves id-referenced links to slugs and drops dangling edges", async () => {
    const pages = [
      { id: "uuid-1", slug: "alpha", title: "Alpha", type: "note", updated_at: new Date("2026-11-03T08:00:00Z") },
      { id: "uuid-2", slug: "beta", type: "person", updated_at: new Date("2026-11-04T09:30:00Z") },
      { id: "uuid-3", slug: "gamma", updated_at: new Date("2026-11-01T00:00:00Z") },
    ];
    const links = [
      { from: "uuid-1", to: "uuid-2", link_type: "mentions", link_source: "dream" },
      { from: "beta", to: "gamma" }, // slug-direct reference also works
      { from: "uuid-1", to: "missing", link_type: "cites" }, // dangling → dropped
      { from: "uuid-2", to: "uuid-2" }, // self-loop → dropped
    ];
    const driver = new PgReadonlyDriver({
      dsn: "postgresql://x",
      query: makeQuery([
        COLUMNS,
        { text: "SELECT id, slug, title, type, updated_at FROM pages", rows: pages },
        { text: SQL_LINKS, rows: links },
        { text: SQL_PROBE_PAGES, rows: [{ n: 3, m: 1762258200 }] },
        { text: SQL_PROBE_LINKS, rows: [{ n: 2 }] },
      ]),
    });

    const { snapshot, stale } = await driver.getGraph();
    expect(stale).toBe(false);
    expect(snapshot.nodes).toHaveLength(3);
    expect(snapshot.edges).toEqual([
      { source: "alpha", target: "beta", link_type: "mentions", link_source: "dream" },
      { source: "beta", target: "gamma" },
    ]);
    const byslug = Object.fromEntries(snapshot.nodes.map((n) => [n.slug, n]));
    expect(byslug.alpha!.degree).toBe(1);
    expect(byslug.beta!.degree).toBe(2);
    expect(byslug.gamma!.degree).toBe(1);
    expect(byslug.alpha!.title).toBe("Alpha");
    // fingerprint reflects counts + max updated_at epoch (2026-11-04T09:30Z)
    expect(snapshot.fingerprint).toBe(`p3/${Math.floor(Date.parse("2026-11-04T09:30:00Z") / 1000)}/l2`);
  });

  test("serves the cache without a full reload while the fingerprint matches", async () => {
    const pages = [{ id: 1, slug: "only", updated_at: new Date("2026-11-02T00:00:00Z") }];
    const log: string[] = [];
    const driver = new PgReadonlyDriver({
      dsn: "postgresql://x",
      query: async (text) => {
        log.push(text);
        if (text === SQL_PROBE_PAGES) return [{ n: 1, m: Math.floor(Date.parse("2026-11-02T00:00:00Z") / 1000) }];
        if (text === SQL_PROBE_LINKS) return [{ n: 0 }];
        if (text === COLUMNS.text) return COLUMNS.rows;
        if (text === "SELECT id, slug, title, type, updated_at FROM pages") return pages;
        if (text === SQL_LINKS) return [];
        throw new Error(`unexpected: ${text}`);
      },
    });

    await driver.getGraph(); // full load
    const fullLoadsBefore = log.filter((q) => q.includes("FROM links") && q.includes("from")).length;
    const second = await driver.getGraph(); // probe matches → cache
    expect(second.stale).toBe(false);
    const fullLoadsAfter = log.filter((q) => q.includes("FROM links") && q.includes("from")).length;
    expect(fullLoadsAfter).toBe(fullLoadsBefore);
  });

  test("marks the snapshot stale when the database goes away after caching", async () => {
    let up = true;
    const pages = [{ id: 1, slug: "only", updated_at: new Date("2026-11-02T00:00:00Z") }];
    const driver = new PgReadonlyDriver({
      dsn: "postgresql://x",
      query: async (text) => {
        if (!up) throw new Error("connection refused");
        if (text === SQL_PROBE_PAGES) return [{ n: 1, m: Math.floor(Date.parse("2026-11-02T00:00:00Z") / 1000) }];
        if (text === SQL_PROBE_LINKS) return [{ n: 0 }];
        if (text === COLUMNS.text) return COLUMNS.rows;
        if (text === "SELECT id, slug, title, type, updated_at FROM pages") return pages;
        if (text === SQL_LINKS) return [];
        throw new Error(`unexpected: ${text}`);
      },
    });

    const first = await driver.getGraph();
    expect(first.stale).toBe(false);
    up = false;
    const second = await driver.getGraph();
    expect(second.stale).toBe(true);
    expect(second.error).toContain("connection refused");
    expect(second.snapshot.nodes).toHaveLength(1);
  });

  test("reads the live-probed 0.60.558 schema (from_page_id/to_page_id integer FKs)", async () => {
    const columns: Script = {
      text: COLUMNS.text,
      rows: [
        { table_name: "pages", column_name: "id" },
        { table_name: "pages", column_name: "slug" },
        { table_name: "pages", column_name: "title" },
        { table_name: "pages", column_name: "type" },
        { table_name: "pages", column_name: "updated_at" },
        { table_name: "links", column_name: "from_page_id" },
        { table_name: "links", column_name: "to_page_id" },
        { table_name: "links", column_name: "link_type" },
        { table_name: "links", column_name: "link_source" },
      ],
    };
    const pages = [
      { id: 1, slug: "alpha", type: "note", updated_at: new Date("2026-11-04T08:00:00Z") },
      { id: 2, slug: "beta", type: "person", updated_at: new Date("2026-11-04T09:00:00Z") },
    ];
    const links = [
      { from_page_id: 1, to_page_id: 2, link_type: "mentions", link_source: "manual" },
      { from_page_id: 2, to_page_id: 999, link_type: "cites" }, // dangling → dropped
    ];
    const driver = new PgReadonlyDriver({
      dsn: "postgresql://x",
      query: makeQuery([
        columns,
        { text: "SELECT id, slug, title, type, updated_at FROM pages", rows: pages },
        {
          text: 'SELECT "from_page_id", "to_page_id", "link_type", "link_source" FROM links',
          rows: links,
        },
        { text: SQL_PROBE_PAGES, rows: [{ n: 2, m: 1793750400 }] },
        { text: SQL_PROBE_LINKS, rows: [{ n: 1 }] },
      ]),
    });

    const { snapshot } = await driver.getGraph();
    expect(snapshot.edges).toEqual([
      { source: "alpha", target: "beta", link_type: "mentions", link_source: "manual" },
    ]);
    expect(snapshot.nodes).toHaveLength(2);
  });

  test("fails closed when pages has no slug column", async () => {
    const noSlug = {
      text: COLUMNS.text,
      rows: [
        { table_name: "pages", column_name: "id" },
        { table_name: "pages", column_name: "title" },
      ],
    };
    const driver = new PgReadonlyDriver({
      dsn: "postgresql://x",
      query: makeQuery([noSlug, { text: SQL_PROBE_PAGES, rows: [{ n: 0, m: -1 }] }, { text: SQL_PROBE_LINKS, rows: [{ n: 0 }] }]),
    });
    await expect(driver.getGraph()).rejects.toThrow("slug");
  });

  test("ping measures through the fixed probe statement", async () => {
    const log: string[] = [];
    const driver = new PgReadonlyDriver({
      dsn: "postgresql://x",
      query: makeQuery([{ text: SQL_PROBE_PAGES, rows: [{ n: 0, m: -1 }] }], log),
    });
    const ms = await driver.ping();
    expect(typeof ms).toBe("number");
    expect(ms).toBeGreaterThanOrEqual(0);
    expect(log).toEqual([SQL_PROBE_PAGES]);
  });
});

// --- Inbox takes queue (multi-source visibility fix) --------------------------

const SQL_TAKES_PENDING =
  "SELECT id, source_id, page_slug, claim_text, kind, holder, weight, domain, status, proposed_at, model_id, promoted_row_num " +
  "FROM take_proposals WHERE status = 'pending' " +
  "ORDER BY proposed_at DESC, id DESC LIMIT 9999";

describe("PgReadonlyDriver pendingTakeProposals", () => {
  test("unconfigured throws without querying", async () => {
    const log: string[] = [];
    const driver = new PgReadonlyDriver({ dsn: null, query: makeQuery([], log) });
    await expect(driver.pendingTakeProposals()).rejects.toThrow(/not configured/);
    expect(log.length).toBe(0);
  });

  test("reads cross-source rows through the ONE fixed statement, CLI-shaped", async () => {
    const log: string[] = [];
    const driver = new PgReadonlyDriver({
      dsn: "postgresql://x",
      query: makeQuery(
        [
          {
            text: SQL_TAKES_PENDING,
            rows: [
              {
                id: 6,
                source_id: "mail-import",
                page_slug: "issue/bug-1234",
                claim_text: "claim six",
                kind: "take",
                holder: "brain",
                weight: "0.70", // pg numeric arrives as string
                domain: null,
                status: "pending",
                proposed_at: new Date("2026-11-06T05:12:00Z"),
                model_id: "qwen3",
                promoted_row_num: null,
              },
              {
                id: 657,
                source_id: "default",
                page_slug: "atlas-page",
                claim_text: "legacy default-source row",
                kind: "fact",
                holder: "world",
                weight: 0.5,
                domain: "ops",
                status: "pending",
                proposed_at: "2026-11-05T00:00:00Z",
                model_id: null,
                promoted_row_num: 4,
              },
            ],
          },
        ],
        log,
      ),
    });
    const items = await driver.pendingTakeProposals();
    expect(log).toEqual([SQL_TAKES_PENDING]); // the whole SQL surface, once
    expect(items).toHaveLength(2);
    // both sources visible — the whole point of the bypass queue
    expect(items[0]).toEqual({
      id: 6,
      source_id: "mail-import",
      page_slug: "issue/bug-1234",
      claim_text: "claim six",
      kind: "take",
      holder: "brain",
      weight: 0.7, // numeric coerced, mirrors upstream's normalize
      status: "pending",
      proposed_at: "2026-11-06T05:12:00.000Z", // Date → ISO (ms), the CLI JSON shape
      model_id: "qwen3",
    });
    expect(items[1]).toEqual({
      id: 657,
      source_id: "default",
      page_slug: "atlas-page",
      claim_text: "legacy default-source row",
      kind: "fact",
      holder: "world",
      weight: 0.5,
      domain: "ops",
      status: "pending",
      proposed_at: "2026-11-05T00:00:00Z",
      promoted_row_num: 4,
    });
  });

  test("query failures propagate to the route (queue down, never a crash)", async () => {
    const driver = new PgReadonlyDriver({
      dsn: "postgresql://x",
      query: async () => {
        throw new Error('permission denied for table take_proposals');
      },
    });
    await expect(driver.pendingTakeProposals()).rejects.toThrow(/permission denied/);
  });
});

// --- multi-source identity (Phase 6): (source_id, slug) keys -----------------

const COLUMNS_WITH_SOURCE: Script = {
  ...COLUMNS,
  rows: [...COLUMNS.rows, { table_name: "pages", column_name: "source_id" }],
};
const SQL_PAGES_SRC =
  "SELECT id, slug, title, type, updated_at, source_id FROM pages";

describe("PgReadonlyDriver multi-source identity", () => {
  test("same-slug pages in two sources become TWO nodes; edges key on source/slug", async () => {
    const pages = [
      { id: "u1", slug: "kb/migration0007", source_id: "main", updated_at: new Date("2026-11-04T08:00:00Z") },
      { id: "u2", slug: "kb/migration0007", source_id: "archive", updated_at: new Date("2026-11-05T08:00:00Z") },
      { id: "u3", slug: "yon-bip", source_id: "main", updated_at: new Date("2026-11-05T09:00:00Z") },
    ];
    const links = [
      { from: "u1", to: "u3", link_type: "relates" }, // same-source edge
      { from: "u2", to: "u3", link_type: "relates" }, // cross-source edge
    ];
    const driver = new PgReadonlyDriver({
      dsn: "postgres://x",
      query: makeQuery([
        COLUMNS_WITH_SOURCE,
        { text: SQL_PAGES_SRC, rows: pages },
        { text: SQL_LINKS, rows: links },
      ]),
    });
    const { snapshot } = await driver.getGraph();
    expect(snapshot.nodes.map((n) => n.key).sort()).toEqual([
      "archive/kb/migration0007",
      "main/kb/migration0007",
      "main/yon-bip",
    ]);
    const same = snapshot.nodes.find((n) => n.key === "main/kb/migration0007");
    expect(same?.slug).toBe("kb/migration0007"); // slug stays the label
    expect(same?.source_id).toBe("main");
    expect(snapshot.edges).toHaveLength(2);
    expect(snapshot.edges).toContainEqual({
      source: "archive/kb/migration0007",
      target: "main/yon-bip",
      link_type: "relates",
    });
    // schema marker present in the fingerprint (one-time layout invalidation)
    expect(snapshot.fingerprint).toMatch(/^p3s\//);
  });

  test("an ambiguous slug endpoint drops its edge instead of guessing a node", async () => {
    const pages = [
      { id: "u1", slug: "dup", source_id: "main", updated_at: new Date("2026-11-04T08:00:00Z") },
      { id: "u2", slug: "dup", source_id: "archive", updated_at: new Date("2026-11-04T08:00:00Z") },
      { id: "u3", slug: "solo", source_id: "main", updated_at: new Date("2026-11-04T08:00:00Z") },
    ];
    const links = [
      { from: "dup", to: "solo" }, // slug endpoint, ambiguous
      { from: "solo", to: "u1" }, // id endpoint, fine
    ];
    const driver = new PgReadonlyDriver({
      dsn: "postgres://x",
      query: makeQuery([
        COLUMNS_WITH_SOURCE,
        { text: SQL_PAGES_SRC, rows: pages },
        { text: SQL_LINKS, rows: links },
      ]),
    });
    const { snapshot } = await driver.getGraph();
    expect(snapshot.edges).toHaveLength(1);
    expect(snapshot.edges[0]!.source).toBe("main/solo");
  });

  test("schema without the source column stays on slug keys (degraded mode)", async () => {
    const pages = [
      { id: "u1", slug: "alpha", updated_at: new Date("2026-11-04T08:00:00Z") },
      { id: "u2", slug: "beta", updated_at: new Date("2026-11-04T08:00:00Z") },
    ];
    const driver = new PgReadonlyDriver({
      dsn: "postgres://x",
      query: makeQuery([
        COLUMNS,
        {
          text: "SELECT id, slug, title, type, updated_at FROM pages",
          rows: pages,
        },
        { text: SQL_LINKS, rows: [] },
      ]),
    });
    const { snapshot } = await driver.getGraph();
    expect(snapshot.nodes.map((n) => n.key)).toEqual(["alpha", "beta"]);
    expect(snapshot.nodes[0]!.source_id).toBeUndefined();
    expect(snapshot.fingerprint).toMatch(/^p2\//); // no "s" marker
  });
});
