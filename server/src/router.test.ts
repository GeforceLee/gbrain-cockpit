import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { BrainRegistry } from "./brains";
import { loadConfig } from "./config";
import { createInboxStateStore } from "./inbox-state";
import { loadProfiles } from "./profiles";
import { TokenVerifier } from "./auth";
import { auditTail } from "./audit";
import { EMPTY_REGISTRY_TEXT, TokenRegistry } from "./tokens";
import {
  handleApi,
  POST_READ_PATHS,
  ROUTES,
  routeKeys,
  type RouteDeps,
  type RouteRow,
} from "./router";
import { mapError } from "./routes/api";
import { reliefKey } from "./routes/api";

// The route table's contract (ROADMAP-named-tokens §3.4, tests T1–T4): every
// row is classified, the gate runs before any handler, and a named token is
// refused unless its sheet says otherwise. The tests walk the REAL table, so
// a route added later is covered the day it is added.

const PROFILES = JSON.stringify([
  { id: "atlas", name: "atlas-brain", mcpUrl: "http://127.0.0.1:3131/mcp", mcpToken: "tok-a", cliBin: "gbrain" },
  { id: "bip", name: "bip-brain", mcpUrl: "http://127.0.0.1:3132/mcp", mcpToken: "tok-b", cliBin: "gbrain-bip" },
]);
const ATLAS_ONLY = JSON.stringify([
  { id: "atlas", name: "atlas-brain", mcpUrl: "http://127.0.0.1:3131/mcp", mcpToken: "tok-a" },
]);

/** The five routes the owner's BASE env token may not use (admin tier). */
const ADMIN_GATED = new Set([
  "POST /api/tokens",
  "PUT /api/tokens/grants",
  "POST /api/tokens/revoke",
  "POST /api/ops/grant-read",
  "POST /api/ops/model/test",
]);

/** Query strings / bodies that let a permitted call reach a 200 (not a 400). */
const QUERY: Record<string, string> = {
  "/api/page": "?slug=a",
  "/api/search": "?q=a",
  "/api/resolve-slugs": "?partial=a",
  "/api/ask": "?q=a",
};
const BODY: Record<string, string> = {
  "/api/evidence": JSON.stringify({ hits: [{ slug: "a", source_id: "default", chunk_id: 1 }] }),
  "/api/ask/missing": JSON.stringify({ q: "x", target: "a" }),
};

function answer(tool: string): unknown {
  switch (tool) {
    case "get_page":
      return { slug: "a", source_id: "default", source_path: "/home/dev/x/a.md", revision: "r1", content: "x", title: "A" };
    case "query":
      return { results: [] };
    case "find_contradictions":
      return { ran_at: "2026-11-27T00:00:00Z" };
    case "extraction_pending":
      return { pending: [] };
    case "takes_resolve":
      return { ok: true };
    case "whoami":
      return { transport: "legacy", scopes: ["read", "write"] };
    case "schema_stats":
      return { aggregate: { total_pages: 0, by_type: [] } };
    default:
      return [];
  }
}

function fakeMcp(fail?: string) {
  const urls: string[] = [];
  const fetchFn = (async (input: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      method?: string;
      params?: { name?: string };
    };
    if (fail && body.method === "tools/call") throw new Error(fail);
    if (body.method === "tools/call") urls.push(String(input));
    const result =
      body.method === "initialize"
        ? {}
        : {
            content: [
              { type: "text", text: JSON.stringify(answer(body.params?.name ?? "")) },
            ],
          };
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { fetchFn, urls };
}

const open: TokenRegistry[] = [];

afterEach(() => {
  while (open.length) open.pop()!.dispose();
});

async function setup(
  opts: {
    profiles?: string;
    withTokens?: boolean;
    origins?: string;
    fail?: string;
    /** a deployment without COCKPIT_ADMIN_TOKEN */
    noAdmin?: boolean;
  } = {},
) {
  const mcp = fakeMcp(opts.fail);
  const registry = await BrainRegistry.create(
    loadProfiles({ COCKPIT_PROFILES_FILE: "/x" }, { readFile: () => opts.profiles ?? PROFILES }),
    { which: async () => null, accessX: async () => false, fetchFn: mcp.fetchFn },
  );
  const verifier = new TokenVerifier({
    base: "base-token",
    ...(opts.noAdmin ? {} : { admin: "admin-token" }),
  });
  const dir = mkdtempSync(join(tmpdir(), "cockpit-router-"));
  let tokens: TokenRegistry | null = null;
  let file = "";
  if (opts.withTokens !== false) {
    file = join(dir, "tokens.json");
    writeFileSync(file, EMPTY_REGISTRY_TEXT, { mode: 0o600 });
    tokens = TokenRegistry.load(file, {
      knownBrains: () => new Set(registry.profileIds()),
      auditStrict: async () => undefined,
      auditSoft: async () => undefined,
    });
    open.push(tokens);
  }
  const cfg = loadConfig({
    COCKPIT_TOKEN: "base-token",
    ...(opts.noAdmin ? {} : { COCKPIT_ADMIN_TOKEN: "admin-token" }),
    ...(opts.origins !== "" ? { COCKPIT_ALLOWED_ORIGINS: opts.origins ?? "https://cockpit.example.com" } : {}),
  });
  const inboxStore = createInboxStateStore({ file: join(dir, "inbox.json") });
  const deps: RouteDeps = { cfg, verifier, registry, tokens, inboxStore };
  return { deps, mcp, tokens, file, dir };
}

interface Call {
  token?: string | null;
  method?: string;
  body?: string;
  brain?: string;
}

function call(deps: RouteDeps, path: string, opts: Call = {}): Promise<Response> {
  const method = opts.method ?? "GET";
  const headers: Record<string, string> = {};
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.brain) headers["x-brain-profile"] = opts.brain;
  if (method !== "GET") headers["content-type"] = "application/json";
  const req = new Request(`http://127.0.0.1:8787${path}`, {
    method,
    headers,
    body: method === "GET" ? undefined : (opts.body ?? BODY[path] ?? "{}"),
  });
  // handlers throw their validation errors; the entry file's catch-all maps
  // them — the harness does the same
  return handleApi(req, new URL(req.url), deps).catch(mapError);
}

const json = async (res: Response) => (await res.json()) as Record<string, any>;

async function issue(
  tokens: TokenRegistry,
  sheet: { name: string; brains: string[]; adjudicate: boolean },
): Promise<string> {
  return (await tokens.issue(sheet, "owner (admin)")).token;
}

describe("the table itself (T4)", () => {
  test("every row is classified, and only the two body-carrying reads are POST/PUT 'view'", () => {
    const writesFiledAsView = ROUTES.filter(
      (r) => r.perm === "view" && r.method !== "GET",
    ).map((r) => r.path);
    expect(writesFiledAsView.sort()).toEqual([...POST_READ_PATHS].sort());
    expect(POST_READ_PATHS).toEqual(["/api/evidence", "/api/ask/missing"]);
    // the unauthenticated probe is NOT a table row
    expect(routeKeys()).not.toContain("GET /healthz");
    // the 40 routes of 0.6 + the 5 new ones
    expect([...routeKeys()].sort()).toEqual(
      [
        // 0.6's forty routes
        "GET /api/profiles",
        "GET /api/healthz",
        "GET /api/graph",
        "GET /api/pages",
        "GET /api/pages/facets",
        "GET /api/page",
        "GET /api/search",
        "GET /api/sources",
        "GET /api/sources/status",
        "GET /api/ops/sources-drift",
        "GET /api/ops/clients",
        "GET /api/ops/dream-runs",
        "GET /api/ops/nightly",
        "GET /api/ops/calibration",
        "GET /api/ops/assets",
        "GET /api/ops/deploy",
        "GET /api/ops/model",
        "GET /api/inbox",
        "GET /api/resolve-slugs",
        "GET /api/brain-health",
        "GET /api/anomalies",
        "GET /api/audit-history",
        "GET /api/write-request",
        "GET /api/write-requests",
        "GET /api/write-conflicts",
        "GET /api/ask",
        "POST /api/ops/model/test",
        "POST /api/ops/grant-read",
        "POST /api/inbox/relief",
        "POST /api/inbox/trust/drop",
        "POST /api/inbox/edge",
        "POST /api/inbox/contradictions",
        "POST /api/inbox/takes/propose",
        "POST /api/inbox/takes/resolve",
        "POST /api/write-cancel",
        "POST /api/inbox/confirm",
        "PUT /api/page",
        "POST /api/evidence",
        "POST /api/ask/think",
        "POST /api/ask/missing",
        // 0.7's five
        "GET /api/me",
        "GET /api/tokens",
        "POST /api/tokens",
        "PUT /api/tokens/grants",
        "POST /api/tokens/revoke",
      ].sort(),
    );
  });

  test("every row declares one of the four classes", () => {
    for (const row of ROUTES) {
      expect(["view", "adjudicate", "edit", "owner-only"]).toContain(row.perm);
    }
  });
});

describe("T1 — a view-only named token", () => {
  test("reaches every view row and is refused by every other row with the missing grant named", async () => {
    const { deps, tokens } = await setup();
    const view = await issue(tokens!, { name: "看客", brains: ["bip"], adjudicate: false });
    for (const row of ROUTES) {
      const res = await call(deps, row.path + (QUERY[row.path] ?? ""), {
        token: view,
        method: row.method,
      });
      if (row.perm === "view") {
        expect(res.status).toBe(200);
        continue;
      }
      expect(res.status).toBe(403);
      const body = await json(res);
      expect(body.code).toBe("E_FORBIDDEN");
      expect(body.missing).toBe(row.perm);
    }
  });

  test("learns who it is, sees only its brains, and gets no command text or host paths", async () => {
    const { deps, tokens, mcp } = await setup();
    const view = await issue(tokens!, { name: "看客", brains: ["bip"], adjudicate: false });

    const me = await json(await call(deps, "/api/me", { token: view }));
    expect(me.kind).toBe("token");
    expect(me.name).toBe("看客");
    expect(me.brains).toEqual(["bip"]);
    expect(me.permissions.adjudicate).toBe(false);

    const profiles = await json(await call(deps, "/api/profiles", { token: view }));
    expect(profiles.profiles.map((p: { id: string }) => p.id)).toEqual(["bip"]);
    expect(profiles.defaultId).toBe("bip");
    expect(profiles.adminTier).toBe(false);
    expect(JSON.stringify(profiles)).not.toContain("cliCommand");

    const inbox = await json(await call(deps, "/api/inbox", { token: view }));
    expect(Object.keys(inbox)).toEqual(["edgeProposals"]);
    expect("error" in inbox.edgeProposals).toBe(false);

    const page = await json(await call(deps, "/api/page?slug=a", { token: view }));
    expect(page.page.source_path).toBeUndefined();

    const history = await json(await call(deps, "/api/audit-history", { token: view }));
    expect("audit" in history).toBe(false);

    // and nothing it was given carries the owner's terminal material
    expect(mcp.urls.every((u) => u.includes(":3132"))).toBe(true);
  });

  test("every response is uncacheable and carries the anti-framing headers", async () => {
    const { deps, tokens } = await setup();
    const view = await issue(tokens!, { name: "看客", brains: ["bip"], adjudicate: false });
    for (const res of [
      await call(deps, "/api/me", { token: view }),
      await call(deps, "/api/ops/clients", { token: view }),
      await call(deps, "/api/me"),
    ]) {
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("content-security-policy")).toBe("frame-ancestors 'self'");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    }
  });
});

describe("T1b — an adjudicating named token", () => {
  test("gets view + adjudicate, is refused for edit and owner-only", async () => {
    const { deps, tokens } = await setup();
    const adj = await issue(tokens!, { name: "裁决员", brains: ["bip"], adjudicate: true });
    for (const row of ROUTES) {
      const res = await call(deps, row.path + (QUERY[row.path] ?? ""), {
        token: adj,
        method: row.method,
      });
      if (row.perm === "view" || row.perm === "adjudicate") {
        expect(res.status).not.toBe(403);
        expect(res.status).not.toBe(401);
        continue;
      }
      expect(res.status).toBe(403);
      expect((await json(res)).missing).toBe(row.perm);
    }
  });

  test("gets the inbox queues without any command text", async () => {
    const { deps, tokens } = await setup();
    const adj = await issue(tokens!, { name: "裁决员", brains: ["bip"], adjudicate: true });
    const mine = await json(await call(deps, "/api/inbox", { token: adj }));
    const owners = await json(
      await call(deps, "/api/inbox", { token: "base-token", brain: "bip" }),
    );
    expect(owners.cliChannel.command).toBe("gbrain-bip");
    expect(typeof owners.cliChannel.error).toBe("string");
    expect(mine.cliChannel.command).toBeUndefined();
    expect(mine.cliChannel.error).toBeUndefined();
    expect("error" in mine.edgeProposals).toBe(false); // upstream's stderr line
    expect(JSON.stringify(mine)).not.toContain("GBRAIN_HOME");
    expect(JSON.stringify(mine)).not.toContain("gbrain binary not found");
    expect(mine.edgeProposals).toBeDefined();
    expect(mine.takes).toBeDefined();
  });

  test("its adjudications land in the audit trail under its name and id", async () => {
    const { deps, tokens } = await setup();
    const adj = await issue(tokens!, { name: "丙", brains: ["bip"], adjudicate: true });
    const res = await call(deps, "/api/inbox/takes/resolve", {
      token: adj,
      method: "POST",
      body: JSON.stringify({ slug: "a", row: 1, quality: "correct" }),
    });
    expect(res.status).toBe(200);
    const line = (await auditTail(20)).find(
      (e) => e.action === "takes.resolve" && e.actor === "丙",
    );
    expect(line?.actor_kind).toBe("token");
    expect(line?.actor_id).toMatch(/^tk_[0-9a-f]{12}$/);
    expect(line?.profile).toBe("bip");
  });
});

describe("T2 — the owner's env tokens keep what they had", () => {
  test("the base token reaches everything except the five admin-gated routes", async () => {
    const { deps } = await setup();
    for (const row of ROUTES) {
      const res = await call(deps, row.path + (QUERY[row.path] ?? ""), {
        token: "base-token",
        method: row.method,
      });
      const key = `${row.method} ${row.path}`;
      if (ADMIN_GATED.has(key)) {
        // the owner's base token: a structured "needs the admin token" — the
        // UI offers the paste prompt on exactly this marker
        expect(res.status).toBe(403);
        expect((await json(res)).missing).toBe("admin-tier");
        continue;
      }
      expect([401, 403]).not.toContain(res.status);
    }
  });

  test("the admin token reaches everything, with the full profile list and audit tail", async () => {
    const { deps } = await setup();
    for (const row of ROUTES) {
      const res = await call(deps, row.path + (QUERY[row.path] ?? ""), {
        token: "admin-token",
        method: row.method,
      });
      expect([401, 403]).not.toContain(res.status);
    }
    const profiles = await json(await call(deps, "/api/profiles", { token: "admin-token" }));
    expect(profiles.profiles.map((p: { id: string }) => p.id)).toEqual(["atlas", "bip"]);
    expect(profiles.adminTier).toBe(true);
    expect(profiles.profiles[1].cliCommand).toBe("gbrain-bip");
    const me = await json(await call(deps, "/api/me", { token: "admin-token" }));
    expect(me.permissions.tokensWrite).toBe(true);
    expect(me.defaultBrain).toBe("atlas");
    const history = await json(await call(deps, "/api/audit-history", { token: "admin-token" }));
    expect(Array.isArray(history.audit)).toBe(true);
    const page = await json(await call(deps, "/api/page?slug=a", { token: "admin-token" }));
    expect(page.page.source_path).toBe("/home/dev/x/a.md");
  });
});

describe("T3 — which brain a request goes to", () => {
  test("no header, wrong header and unknown header (owner: unchanged 0.6 behaviour)", async () => {
    const { deps, mcp } = await setup();
    mcp.urls.length = 0;
    expect((await call(deps, "/api/sources", { token: "base-token" })).status).toBe(200);
    expect(mcp.urls.at(-1)).toContain(":3131"); // brains.json's first brain
    expect(
      (await call(deps, "/api/sources", { token: "base-token", brain: "nope" })).status,
    ).toBe(400);
    expect(
      (await call(deps, "/api/sources", { token: "base-token", brain: "BAD ID" })).status,
    ).toBe(400);
  });

  test("a named token without a header lands on the first brain of its sheet", async () => {
    const { deps, tokens, mcp } = await setup();
    const view = await issue(tokens!, { name: "看客", brains: ["bip"], adjudicate: false });
    mcp.urls.length = 0;
    const res = await call(deps, "/api/sources", { token: view });
    expect(res.status).toBe(200);
    expect(mcp.urls).toHaveLength(1);
    expect(mcp.urls[0]).toContain(":3132");
  });

  test("a brain off the sheet and a brain that does not exist answer byte-identically", async () => {
    const { deps, tokens, mcp } = await setup();
    const view = await issue(tokens!, { name: "看客", brains: ["bip"], adjudicate: false });
    mcp.urls.length = 0;
    const off = await call(deps, "/api/sources", { token: view, brain: "atlas" });
    const ghost = await call(deps, "/api/sources", { token: view, brain: "ghost" });
    expect(off.status).toBe(403);
    const offText = await off.text();
    expect(offText).toBe(await ghost.text());
    expect(JSON.parse(offText).missing).toBe("brain");
    expect(offText).not.toContain("atlas");
    expect(mcp.urls).toHaveLength(0);
  });

  test("a sheet brain that is gone from brains.json is a 403 — never a fallback to another brain", async () => {
    const { deps, mcp, file } = await setup({ profiles: ATLAS_ONLY });
    const token = `ck_${"a".repeat(43)}`;
    const hash = createHash("sha256").update(token, "utf8").digest("hex");
    deps.tokens!.dispose();
    open.pop();
    writeFileSync(
      file,
      `{"version":1,"tokens":[{"id":"tk_0123456789ab","name":"甲","hash":"${hash}","brains":["bip"],"adjudicate":false,"editSources":[],"createdAt":"2026-11-27T00:00:00.000Z","createdBy":"owner (admin)","revokedAt":null,"revokedBy":null,"lastUsedAt":null}]}\n`,
      { mode: 0o600 },
    );
    const tokens = TokenRegistry.load(file, {
      knownBrains: () => new Set(deps.registry.profileIds()),
      auditStrict: async () => undefined,
    });
    open.push(tokens);
    deps.tokens = tokens;
    mcp.urls.length = 0;
    const res = await call(deps, "/api/sources", { token });
    expect(res.status).toBe(403);
    expect((await json(res)).missing).toBe("brain");
    expect(mcp.urls).toHaveLength(0);
    // the brain-less routes still answer: the UI can always learn who it is
    expect((await call(deps, "/api/me", { token })).status).toBe(200);
    const profiles = await json(await call(deps, "/api/profiles", { token }));
    expect(profiles.profiles).toEqual([]);
    expect(profiles.defaultId).toBe("");
  });
});

describe("token management over HTTP", () => {
  test("issue (admin) → the plaintext rides one response; the roster never carries it or a hash", async () => {
    const { deps, file } = await setup();
    const res = await call(deps, "/api/tokens", {
      token: "admin-token",
      method: "POST",
      body: JSON.stringify({ name: "张三", brains: ["bip"], adjudicate: true }),
    });
    expect(res.status).toBe(201);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const issued = await json(res);
    expect(issued.token).toMatch(/^ck_[A-Za-z0-9_-]{43}$/);
    expect(issued.record.name).toBe("张三");

    const roster = await call(deps, "/api/tokens", { token: "base-token" });
    expect(roster.status).toBe(200);
    const rosterText = await roster.text();
    expect(rosterText).not.toContain(issued.token);
    expect(rosterText).not.toMatch(/[0-9a-f]{64}/);
    expect(readFileSync(file, "utf8")).not.toContain(issued.token);
    expect(JSON.stringify(await auditTail(20))).not.toContain(issued.token);
  });

  test("the base token is asked to step up; a named token is told it is owner-only", async () => {
    const { deps, tokens } = await setup();
    const body = JSON.stringify({ name: "李四", brains: ["bip"], adjudicate: false });
    const base = await call(deps, "/api/tokens", { token: "base-token", method: "POST", body });
    expect(base.status).toBe(403);
    expect((await base.text())).toContain("step-up prompt");
    const named = await issue(tokens!, { name: "看客", brains: ["bip"], adjudicate: false });
    const refused = await call(deps, "/api/tokens", { token: named, method: "POST", body });
    expect(refused.status).toBe(403);
    const refusedText = await refused.text();
    expect(JSON.parse(refusedText).missing).toBe("owner-only");
    expect(refusedText).not.toContain("step-up");
  });

  test("malformed requests are 400s; unknown ids are 404s", async () => {
    const { deps, tokens } = await setup();
    const admin = { token: "admin-token", method: "POST" } as const;
    const bad = [
      ["/api/tokens", { ...admin, body: JSON.stringify({ name: "李四", brains: ["bip"], adjudicate: false, surprise: 1 }) }],
      ["/api/tokens", { ...admin, body: JSON.stringify({ name: "Owner", brains: ["bip"], adjudicate: false }) }],
      ["/api/tokens", { ...admin, body: JSON.stringify({ name: "李四", brains: ["ghost"], adjudicate: false }) }],
      ["/api/tokens", { ...admin, body: JSON.stringify({ name: "李四", brains: ["bip"], adjudicate: false, editSources: ["metadata"] }) }],
      ["/api/tokens/revoke", { ...admin, body: JSON.stringify({ id: "tk_000000000000" }) }],
      ["/api/tokens/revoke", { ...admin, body: JSON.stringify({}) }],
      ["/api/tokens/grants", { ...admin, method: "PUT", body: JSON.stringify({ id: "tk_000000000000", brains: ["bip"], adjudicate: false, editSources: [] }) }],
      ["/api/tokens/grants", { ...admin, method: "PUT", body: "not json" }],
    ] as const;
    const want = [400, 400, 400, 400, 404, 400, 404, 400];
    for (const [i, [path, opts]] of bad.entries()) {
      const res = await call(deps, path, opts as Call);
      expect(res.status).toBe(want[i]!);
    }
    // a real grant round-trip
    const { token, record } = await tokens!.issue(
      { name: "王五", brains: ["bip"], adjudicate: false },
      "o",
    );
    const regrant = await call(deps, "/api/tokens/grants", {
      ...admin,
      method: "PUT",
      body: JSON.stringify({ id: record.id, brains: ["atlas", "bip"], adjudicate: true, editSources: [] }),
    });
    expect(regrant.status).toBe(200);
    expect((await json(regrant)).record.adjudicate).toBe(true);
    const me = await json(await call(deps, "/api/me", { token }));
    expect(me.permissions.adjudicate).toBe(true);
    expect(me.brains).toEqual(["atlas", "bip"]);
  });

  test("revoking over HTTP takes effect on the next request, with the same 401 as a token that never existed", async () => {
    const { deps, tokens } = await setup();
    const { token, record } = await tokens!.issue(
      { name: "赵六", brains: ["bip"], adjudicate: false },
      "o",
    );
    expect((await call(deps, "/api/me", { token })).status).toBe(200);
    const revoked = await call(deps, "/api/tokens/revoke", {
      token: "admin-token",
      method: "POST",
      body: JSON.stringify({ id: record.id }),
    });
    expect(revoked.status).toBe(200);
    expect((await json(revoked)).record.revokedAt).not.toBeNull();
    const dead = await call(deps, "/api/me", { token });
    const never = await call(deps, "/api/me", { token: `ck_${"z".repeat(43)}` });
    expect(dead.status).toBe(401);
    expect(await dead.text()).toBe(await never.text());
    // the owner's tokens are untouched
    expect((await call(deps, "/api/me", { token: "base-token" })).status).toBe(200);
  });

  test("without a registry the feature is simply off", async () => {
    const { deps } = await setup({ withTokens: false });
    const me = await json(await call(deps, "/api/me", { token: "base-token" }));
    expect(me.permissions.tokens).toBe(false);
    const off = await call(deps, "/api/tokens", { token: "admin-token" });
    expect(off.status).toBe(503);
    expect((await json(off)).code).toBe("E_NOT_CONFIGURED");
    expect((await call(deps, "/api/me", { token: `ck_${"a".repeat(43)}` })).status).toBe(401);
  });
});

describe("the gate's edges", () => {
  test("no token → 401; unknown route → 404 (but only once authenticated); malformed brain header → 400", async () => {
    const { deps } = await setup();
    expect((await call(deps, "/api/me")).status).toBe(401);
    expect((await call(deps, "/api/nope", { token: "base-token" })).status).toBe(404);
    // without a token a caller cannot even tell which routes exist
    expect((await call(deps, "/api/nope")).status).toBe(401);
    expect((await call(deps, "/api/nope", { token: `ck_${"a".repeat(43)}` })).status).toBe(401);
    expect(
      (await call(deps, "/api/sources", { token: "base-token", brain: "BAD ID" })).status,
    ).toBe(400);
  });

  test("the class verdict runs before body validation", async () => {
    const { deps, tokens } = await setup();
    const view = await issue(tokens!, { name: "看客", brains: ["bip"], adjudicate: false });
    const res = await call(deps, "/api/inbox/edge", {
      token: view,
      method: "POST",
      body: "not json",
    });
    expect(res.status).toBe(403);
  });

  test("inbox relief state is per caller", () => {
    const env = { id: "bip", actor: { kind: "env", name: "owner", tier: "base" } } as never;
    const named = {
      id: "bip",
      actor: { kind: "token", name: "张三", tokenId: "tk_0123456789ab" },
    } as never;
    expect(reliefKey(env)).toBe("bip"); // the pre-0.7 key: existing mutes carry over
    expect(reliefKey({ id: "bip" } as never)).toBe("bip");
    expect(reliefKey(named)).toBe("bip#tk_0123456789ab");
  });

  test("trimInboxForToken keeps the queues for an adjudicator and only edges otherwise", async () => {
    const { deps, tokens } = await setup();
    const adj = await issue(tokens!, { name: "裁决员", brains: ["bip"], adjudicate: true });
    const mine = await json(await call(deps, "/api/inbox", { token: adj }));
    for (const key of ["trust", "edgeProposals", "takes", "contradictions", "cliChannel"]) {
      expect(key in mine).toBe(true);
    }
    expect("commands" in mine.takes).toBe(false);
  });
});

describe("what a named token is told when things fail", () => {
  // upstream's own words can name host paths and internal addresses; the
  // owner acts on them, a colleague only needs to know that it did not work
  const HOST_WORDS = "cannot reach /home/dev/gbrain/.gbrain/x at http://10.9.8.7:3132/mcp";

  test("every view answer for a named token carries no host path, address or command material", async () => {
    const { deps, tokens } = await setup({ fail: HOST_WORDS });
    const view = await issue(tokens!, { name: "看客", brains: ["bip"], adjudicate: false });
    let ownerSawHostWords = false;
    for (const row of ROUTES.filter((r) => r.perm === "view")) {
      const mine = await call(deps, row.path + (QUERY[row.path] ?? ""), { token: view, method: row.method });
      const text = await mine.text();
      expect(text).not.toContain("/home/dev");
      expect(text).not.toContain("10.9.8.7");
      expect(text).not.toContain("GBRAIN_HOME");
      expect(text).not.toContain("$1"); // a botched placeholder is a leak of its own
      const owners = await call(deps, row.path + (QUERY[row.path] ?? ""), { token: "base-token", method: row.method });
      if ((await owners.text()).includes("/home/dev")) ownerSawHostWords = true;
    }
    // the fake really did inject host words into some owner answer
    expect(ownerSawHostWords).toBe(true);
  });

  test("an upstream failure keeps its status and code for a named token, with plain words", async () => {
    const { deps, tokens } = await setup({ fail: HOST_WORDS });
    const view = await issue(tokens!, { name: "看客", brains: ["bip"], adjudicate: false });
    // a thrown upstream failure: same status and code, no host words
    const failed = await call(deps, "/api/pages", { token: view });
    expect(failed.status).toBe(502);
    const mine = await json(failed);
    expect(mine.code).toBe("E_UPSTREAM");
    expect(mine.error).not.toContain("/home/dev");
    expect(mine.error).not.toContain("10.9.8.7");
    const ownersRes = await call(deps, "/api/pages", { token: "base-token" });
    expect(ownersRes.status).toBe(502);
    expect((await json(ownersRes)).error).toContain("/home/dev"); // the owner still sees why
    // the caller's own mistake keeps its precise message
    const bad = await json(await call(deps, "/api/pages?limit=abc", { token: view }));
    expect(bad.code).toBe("E_BAD_REQUEST");
    expect(bad.error).toContain("limit");
  });

  test("a channel-down reason loses paths and addresses, keeps its words and content-like slugs", async () => {
    const words =
      "cannot reach /home/dev/gbrain/.gbrain/x at http://10.9.8.7:3132/mcp; config at /etc/x; ~/a/b/c; /single; >/var/log/z.log; 127.0.0.1:3132; [::1]:3132; page kb/x stays";
    const { deps, tokens } = await setup({ fail: words });
    const view = await issue(tokens!, { name: "看客", brains: ["bip"], adjudicate: false });
    const mine = (await json(await call(deps, "/api/sources", { token: view }))).error as string;
    for (const leak of [
      "/home/dev/gbrain",
      "/etc/x",
      "~/a/b/c",
      "/single",
      "/var/log/z.log",
      "127.0.0.1",
      "[::1]",
      "10.9.8.7",
      "$1",
    ]) {
      expect(mine).not.toContain(leak);
    }
    expect(mine).toContain("<path>");
    expect(mine).toContain("<address>");
    expect(mine).toContain("config at <path>"); // the separator survives
    expect(mine).toContain("kb/x"); // a slug is content, not a host path
    const owners = (await json(await call(deps, "/api/sources", { token: "base-token" }))).error as string;
    expect(owners).toContain("/home/dev/gbrain");
  });

  test("without an admin token configured there is no 'wrong token' marker — nothing was pasted wrong", async () => {
    const { deps } = await setup({ noAdmin: true });
    const res = await call(deps, "/api/tokens", {
      token: "base-token",
      method: "POST",
      body: JSON.stringify({ name: "甲", brains: ["bip"], adjudicate: false }),
    });
    expect(res.status).toBe(403);
    const body = await json(res);
    expect(body.missing).toBeUndefined();
    expect(body.error).toContain("not configured");
  });

  test("a named token is not told how the deployment's admin tier is configured", async () => {
    const { deps, tokens } = await setup();
    const view = await issue(tokens!, { name: "看客", brains: ["bip"], adjudicate: false });
    expect((await json(await call(deps, "/api/me", { token: view }))).adminConfigured).toBe(false);
    expect((await json(await call(deps, "/api/me", { token: "base-token" }))).adminConfigured).toBe(true);
  });
});

describe("the plaintext token never reaches a log", () => {
  test("nothing the server prints while issuing and using a token contains it", async () => {
    const { deps } = await setup();
    // capture all three console levels at once, for the whole exchange
    const printed: string[] = [];
    const originals = { log: console.log, warn: console.warn, error: console.error };
    const capture =
      (level: "log" | "warn" | "error") =>
      (...parts: unknown[]) => {
        printed.push(
          parts
            // errors carry their message and stack (JSON would reduce them to {})
          .map((p) =>
            typeof p === "string"
              ? p
              : p instanceof Error
                ? `${p.name}: ${p.message} ${p.stack ?? ""}`
                : JSON.stringify(p),
          )
            .join(" "),
        );
        originals[level](...parts);
      };
    console.log = capture("log");
    console.warn = capture("warn");
    console.error = capture("error");
    try {
      const issued = await json(
        await call(deps, "/api/tokens", {
          token: "admin-token",
          method: "POST",
          body: JSON.stringify({ name: "周九", brains: ["bip"], adjudicate: true }),
        }),
      );
      expect(issued.token).toMatch(/^ck_[A-Za-z0-9_-]{43}$/);
      // use it on several routes, including refusals and malformed input
      await call(deps, "/api/me", { token: issued.token });
      await call(deps, "/api/ops/clients", { token: issued.token });
      await call(deps, "/api/inbox/takes/resolve", {
        token: issued.token,
        method: "POST",
        body: "not json",
      });
      await call(deps, "/api/pages", { token: issued.token });
      // a handler that throws mid-way (the server logs the error object)
      const boom = new Map<string, RouteRow>([
        [
          "GET /api/boom",
          {
            method: "GET",
            path: "/api/boom",
            perm: "view",
            run: async () => {
              throw new TypeError("handler blew up mid-way");
            },
          },
        ],
      ]);
      const req = new Request("http://127.0.0.1:8787/api/boom", {
        headers: { authorization: `Bearer ${issued.token}` },
      });
      expect((await handleApi(req, new URL(req.url), deps, boom)).status).toBe(500);
      const all = printed.join("\n");
      expect(all).toContain("handler blew up mid-way"); // the throw really went through the logger
      await call(deps, "/api/tokens/revoke", {
        token: "admin-token",
        method: "POST",
        body: JSON.stringify({ id: issued.record.id }),
      });
      expect(all).not.toContain(issued.token);
      expect(all).not.toContain("Bearer ");
    } finally {
      console.log = originals.log;
      console.warn = originals.warn;
      console.error = originals.error;
    }
  });
});
