import { describe, expect, test } from "bun:test";
import { ConfigError } from "./config";
import { BrainRegistry } from "./brains";
import { loadProfiles } from "./profiles";
import type { ProfilesConfig } from "./profiles";

// Registry behavior: per-profile driver isolation, custom CLI command
// resolution, fatal-vs-degrade semantics, and the readOnly derivation.

const FILE = JSON.stringify([
  { id: "atlas", mcpUrl: "http://127.0.0.1:3131/mcp", mcpToken: "tok-a" },
  {
    id: "bip",
    mcpUrl: "http://127.0.0.1:3132/mcp",
    mcpToken: "tok-b",
    cliBin: "gbrain-bip",
  },
]);

function config(mode: "file" | "legacy-env", text = FILE): ProfilesConfig {
  return mode === "file"
    ? loadProfiles({ COCKPIT_PROFILES_FILE: "/x" }, { readFile: () => text })
    : loadProfiles({ GBRAIN_MCP_TOKEN: "tok" });
}

/** Fake MCP: initialize + whoami; records the URL + bearer per request. */
function fakeMcp(opts: { scopes?: string[]; fail?: boolean } = {}) {
  const calls: { url: string; auth: string; method: string }[] = [];
  const fetchFn = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      method?: string;
    };
    calls.push({
      url,
      auth: (init?.headers as Record<string, string>)["authorization"] ?? "",
      method: body.method ?? "",
    });
    if (opts.fail) return new Response("boom", { status: 500 });
    if (body.method === "initialize") {
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), {
        headers: { "content-type": "application/json" },
      });
    }
    if (body.method === "tools/call") {
      const payload = {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              transport: "legacy",
              token_name: "cockpit-ui",
              scopes: opts.scopes ?? ["read", "write", "memory_confirm"],
            }),
          },
        ],
      };
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: 1, result: payload }),
        { headers: { "content-type": "application/json" } },
      );
    }
    return new Response(null, { status: 202 });
  }) as typeof fetch;
  return { fetchFn, calls };
}

const WHICH: Record<string, string> = {
  gbrain: "/usr/bin/gbrain",
  "gbrain-bip": "/usr/local/bin/gbrain-bip",
};

const deps = (fetchFn?: typeof fetch) => ({
  which: async (name: string) => WHICH[name] ?? null,
  accessX: async (path: string) => path.startsWith("/usr"),
  ...(fetchFn ? { fetchFn } : {}),
});

describe("BrainRegistry routing", () => {
  test("header ids route to distinct MCP drivers (no cache bleed)", async () => {
    const fake = fakeMcp();
    const reg = await BrainRegistry.create(config("file"), deps(fake.fetchFn));
    const a = reg.resolve("atlas");
    const b = reg.resolve("bip");
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a!.mcp).not.toBe(b!.mcp); // one driver set per profile
    expect(a!.cli).not.toBeNull(); // which gbrain → /usr/bin/gbrain
    expect(b!.cli).not.toBeNull(); // which gbrain-bip → wrapper path
    expect(b!.cliBinResolved).toBe("/usr/local/bin/gbrain-bip");

    await a!.mcp.whoami();
    await b!.mcp.whoami();
    const urls = new Set(fake.calls.map((c) => c.url));
    expect(urls).toContain("http://127.0.0.1:3131/mcp");
    expect(urls).toContain("http://127.0.0.1:3132/mcp");
  });

  test("unknown profile id → null; null/empty id → default profile", async () => {
    const reg = await BrainRegistry.create(config("file"), deps());
    expect(reg.resolve("nope")).toBeNull();
    expect(reg.resolve(null)!.id).toBe("atlas"); // first profile is default
    expect(reg.resolve("")!.id).toBe("atlas");
  });

  test("resolve() returns the SAME channels object per profile (lazy cache)", async () => {
    const reg = await BrainRegistry.create(config("file"), deps());
    expect(reg.resolve("atlas")).toBe(reg.resolve("atlas"));
  });
});

describe("BrainRegistry CLI resolution semantics", () => {
  test("file mode: an unresolvable explicit cliBin degrades ONLY that profile", async () => {
    const reg = await BrainRegistry.create(config("file"), {
      which: async (name) => (name === "gbrain" ? "/usr/bin/gbrain" : null),
      accessX: async () => true,
    });
    const bip = reg.resolve("bip")!;
    expect(bip.cli).toBeNull(); // gbrain-bip not on PATH → degraded
    expect(bip.cliNote).toContain("gbrain-bip");
    expect(reg.resolve("atlas")!.cli).not.toBeNull(); // sibling unaffected
  });

  test("legacy mode: an unresolvable explicit GBRAIN_BIN stays fatal (0.1.1)", async () => {
    const legacy = loadProfiles(
      { GBRAIN_MCP_TOKEN: "t", GBRAIN_BIN: "/gone/bin" },
      { readFile: () => "" },
    );
    await expect(
      BrainRegistry.create(legacy, {
        which: async () => null,
        accessX: async () => false,
      }),
    ).rejects.toThrow(ConfigError);
  });

  test("absolute-path cliBin is X_OK-checked, not PATH-resolved", async () => {
    const withPath = JSON.stringify([
      { id: "a", mcpUrl: "http://a/mcp", mcpToken: "t" },
      {
        id: "bip",
        mcpUrl: "http://b/mcp",
        mcpToken: "t",
        cliBin: "/usr/local/bin/gbrain-bip",
      },
    ]);
    const reg = await BrainRegistry.create(config("file", withPath), {
      which: async () => null,
      accessX: async (p) => p === "/usr/local/bin/gbrain-bip",
    });
    expect(reg.resolve("bip")!.cliBinResolved).toBe(
      "/usr/local/bin/gbrain-bip",
    );
  });
});

describe("BrainRegistry.profileInfos", () => {
  test("derives readOnly from live whoami scopes; unknown when unreachable", async () => {
    // one writable brain, one read-only brain, one dead endpoint
    const file = JSON.stringify([
      { id: "a", mcpUrl: "http://a/mcp", mcpToken: "t" },
      { id: "b", mcpUrl: "http://b/mcp", mcpToken: "t" },
      { id: "dead", mcpUrl: "http://d/mcp", mcpToken: "t" },
    ]);
    const fetchFn = (async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("http://d/")) {
        return new Response("nope", { status: 503 });
      }
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        method?: string;
      };
      if (body.method === "initialize") {
        return new Response(JSON.stringify({ result: {} }), {
          headers: { "content-type": "application/json" },
        });
      }
      const scopes = url.startsWith("http://b") ? ["read"] : ["read", "write"];
      return new Response(
        JSON.stringify({
          result: {
            content: [
              { type: "text", text: JSON.stringify({ scopes }) },
            ],
          },
        }),
        { headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;
    const reg = await BrainRegistry.create(
      loadProfiles({ COCKPIT_PROFILES_FILE: "/x" }, { readFile: () => file }),
      { which: async () => null, fetchFn },
    );
    const infos = await reg.profileInfos();
    const byId = new Map(infos.profiles.map((p) => [p.id, p]));
    expect(byId.get("a")!.readOnly).toBe(false);
    expect(byId.get("b")!.readOnly).toBe(true);
    expect(byId.get("dead")!.readOnly).toBeUndefined(); // unknown ≠ read-only
    expect(byId.get("b")!.cliCommand).toBe("gbrain"); // unset cliBin default
  });
});

// --- takesGuard startup wiring (source-scoped adjudication opt-in) ----------

describe("BrainRegistry takesGuard", () => {
  const brainFile = (extra: Record<string, unknown>) =>
    JSON.stringify([
      {
        id: "bip",
        mcpUrl: "http://127.0.0.1:3132/mcp",
        mcpToken: "tok-b",
        cliBin: "gbrain-bip",
        pgReadonlyDsn: "postgres://cockpit_ro:x@127.0.0.1/bip",
        ...extra,
      },
    ]);

  const guardDeps = (configDb: string | null) => ({
    which: async (name: string) => WHICH[name] ?? null,
    accessX: async (p: string) =>
      p.startsWith("/usr") || p === "/opt/gbrain-real/gbrain",
    readFile: async (p: string) => {
      if (p !== "/srv/brain-bip-home/.gbrain/config.json")
        throw new Error("ENOENT");
      if (configDb === null) throw new Error("ENOENT");
      return JSON.stringify({
        engine: "postgres",
        database_url: `postgresql://u:p@127.0.0.1/${configDb}`,
      });
    },
  });

  test("opt-in profile gets a guard; the binary is X_OK-resolved at startup", async () => {
    const cfg = loadProfiles(
      { COCKPIT_PROFILES_FILE: "/x" },
      {
        readFile: () =>
          brainFile({
            gbrainBin: "/opt/gbrain-real/gbrain",
            gbrainHome: "/srv/brain-bip-home",
          }),
      },
    );
    const reg = await BrainRegistry.create(cfg, guardDeps("bip"));
    const guard = reg.resolve("bip")!.takesGuard;
    expect(guard).not.toBeNull();
    expect(guard!.bin).toBe("/opt/gbrain-real/gbrain");
    expect(reg.resolve("bip")!.takesGuard).toBe(guard); // cached channels
  });

  test("profiles WITHOUT the pair keep takesGuard null (legacy path)", async () => {
    const reg = await BrainRegistry.create(config("file"), guardDeps("bip"));
    expect(reg.resolve("bip")!.takesGuard).toBeNull();
  });

  test("unexecutable gbrainBin is fatal — there is no fallback channel", async () => {
    const cfg = loadProfiles(
      { COCKPIT_PROFILES_FILE: "/x" },
      {
        readFile: () =>
          brainFile({
            gbrainBin: "/nope/gbrain",
            gbrainHome: "/srv/brain-bip-home",
          }),
      },
    );
    await expect(BrainRegistry.create(cfg, guardDeps("bip"))).rejects.toBeInstanceOf(
      ConfigError,
    );
  });

  test("brain config pointing at ANOTHER database is fatal at startup", async () => {
    const cfg = loadProfiles(
      { COCKPIT_PROFILES_FILE: "/x" },
      {
        readFile: () =>
          brainFile({
            gbrainBin: "/opt/gbrain-real/gbrain",
            gbrainHome: "/srv/brain-bip-home",
          }),
      },
    );
    // config.json names "postgres" while the DSN names "bip" — refusing
    // beats silently adjudicating against the wrong brain.
    await expect(BrainRegistry.create(cfg, guardDeps("postgres"))).rejects.toThrow(
      /wrong brain/,
    );
  });

  test("missing brain config file is fatal at startup", async () => {
    const cfg = loadProfiles(
      { COCKPIT_PROFILES_FILE: "/x" },
      {
        readFile: () =>
          brainFile({
            gbrainBin: "/opt/gbrain-real/gbrain",
            gbrainHome: "/srv/brain-bip-home",
          }),
      },
    );
    await expect(BrainRegistry.create(cfg, guardDeps(null))).rejects.toBeInstanceOf(
      ConfigError,
    );
  });
});
