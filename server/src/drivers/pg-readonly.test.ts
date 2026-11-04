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
