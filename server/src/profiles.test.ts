import { describe, expect, test } from "bun:test";
import { mkdir, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError } from "./config";
import { loadProfiles, DEFAULT_PROFILE_ID } from "./profiles";

// Fail-closed matrix for brain connection profiles. Error messages must
// NEVER echo file contents — a sibling profile's valid token must not leak
// into logs through a ConfigError (AGENTS.md non-negotiable #7).

const SECRET = "gb_live_do_not_echo_me_0123456789";

function envWith(file?: string) {
  return {
    ...(file ? { COCKPIT_PROFILES_FILE: file } : {}),
    // legacy vars present in some tests
  };
}

function twoProfileFile() {
  return JSON.stringify([
    {
      id: "atlas",
      name: "atlas-brain",
      mcpUrl: "http://127.0.0.1:3131/mcp",
      mcpToken: "tok-a",
      cliBin: "gbrain",
      pgReadonlyDsn: "postgres://cockpit_ro:x@127.0.0.1/gbrain",
    },
    {
      id: "bip",
      name: "BIP brain",
      mcpUrl: "http://127.0.0.1:3132/mcp",
      mcpToken: "tok-b",
      cliBin: "/usr/local/bin/gbrain-bip",
    },
  ]);
}

describe("loadProfiles — legacy single-instance env", () => {
  test("wraps the legacy vars as one default profile (0.1.1 semantics)", () => {
    const cfg = loadProfiles({
      GBRAIN_MCP_TOKEN: "tok",
      GBRAIN_MCP_URL: "http://10.0.0.4:3131/mcp",
      GBRAIN_BIN: "/opt/gbrain",
      PG_READONLY_DSN: "postgres://ro@h/db",
      GBRAIN_TAKES_HOLDERS: "world,analyst",
    });
    expect(cfg.mode).toBe("legacy-env");
    expect(cfg.defaultId).toBe(DEFAULT_PROFILE_ID);
    expect(cfg.profiles).toHaveLength(1);
    const p = cfg.profiles[0]!;
    expect(p.id).toBe("default");
    expect(p.mcpUrl).toBe("http://10.0.0.4:3131/mcp");
    expect(p.mcpToken).toBe("tok");
    expect(p.cliBin).toBe("/opt/gbrain");
    expect(p.pgReadonlyDsn).toBe("postgres://ro@h/db");
    expect(p.takesHolders).toEqual(["world", "analyst"]);
    expect(cfg.ignoredLegacyVars).toEqual([]);
  });

  test("defaults mcpUrl and omits unset optionals", () => {
    const cfg = loadProfiles({ GBRAIN_MCP_TOKEN: "tok" });
    const p = cfg.profiles[0]!;
    expect(p.mcpUrl).toBe("http://127.0.0.1:3131/mcp");
    expect(p.cliBin).toBeUndefined();
    expect(p.pgReadonlyDsn).toBeUndefined();
  });

  test("missing GBRAIN_MCP_TOKEN fails closed with the mint hint", () => {
    expect(() => loadProfiles({})).toThrow(ConfigError);
    try {
      loadProfiles({});
      expect.unreachable();
    } catch (err) {
      expect((err as ConfigError).message).toContain("GBRAIN_MCP_TOKEN");
      expect((err as ConfigError).hint).toContain("gbrain auth create");
    }
  });
});

describe("loadProfiles — file mode", () => {
  test("happy path: two profiles, file wins over legacy vars", () => {
    const cfg = loadProfiles(
      {
        ...envWith("/etc/brains.json"),
        GBRAIN_MCP_TOKEN: "legacy-tok",
        GBRAIN_BIN: "/old/bin",
      },
      { readFile: () => twoProfileFile() },
    );
    expect(cfg.mode).toBe("file");
    expect(cfg.defaultId).toBe("atlas");
    expect(cfg.profiles.map((p) => p.id)).toEqual(["atlas", "bip"]);
    expect(cfg.ignoredLegacyVars).toEqual(["GBRAIN_MCP_TOKEN", "GBRAIN_BIN"]);
  });

  test("unreadable file fails closed without echoing contents", () => {
    try {
      loadProfiles(envWith("/nope/brains.json"), {
        readFile: () => {
          throw new Error("ENOENT");
        },
      });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).message).not.toContain(SECRET);
    }
  });

  test("invalid JSON fails closed without echoing contents", () => {
    try {
      loadProfiles(envWith("/etc/brains.json"), {
        readFile: () => `{"id":"x","mcpToken":"${SECRET}"}`,
      });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).message).not.toContain(SECRET);
      expect((err as ConfigError).hint).not.toContain(SECRET);
    }
  });

  test("non-array and empty-array files fail closed", () => {
    expect(() =>
      loadProfiles(envWith("/etc/brains.json"), { readFile: () => "42" }),
    ).toThrow(ConfigError);
    expect(() =>
      loadProfiles(envWith("/etc/brains.json"), { readFile: () => "[]" }),
    ).toThrow(ConfigError);
  });

  test("duplicate ids fail closed", () => {
    const dup = JSON.stringify([
      { id: "atlas", mcpUrl: "http://a/mcp", mcpToken: "1" },
      { id: "atlas", mcpUrl: "http://b/mcp", mcpToken: "2" },
    ]);
    expect(() =>
      loadProfiles(envWith("/etc/brains.json"), { readFile: () => dup }),
    ).toThrow(/duplicate profile id/);
  });

  test("invalid id / missing mcpUrl / bad URL fail closed naming the profile", () => {
    expect(() =>
      loadProfiles(envWith("/x"), {
        readFile: () => '[{"id":"Bad_ID","mcpUrl":"http://x/mcp","mcpToken":"t"}]',
      }),
    ).toThrow(/profiles\[0\]\.id/);
    expect(() =>
      loadProfiles(envWith("/x"), {
        readFile: () => '[{"id":"a","mcpToken":"t"}]',
      }),
    ).toThrow(/mcpUrl is required/);
    expect(() =>
      loadProfiles(envWith("/x"), {
        readFile: () => '[{"id":"a","mcpUrl":"ftp://x","mcpToken":"t"}]',
      }),
    ).toThrow(/http\(s\) URL/);
  });

  test("credential rules: neither, both, and bad cliBin all fail closed", () => {
    expect(() =>
      loadProfiles(envWith("/x"), {
        readFile: () => '[{"id":"a","mcpUrl":"http://x/mcp"}]',
      }),
    ).toThrow(/missing MCP credential/);
    expect(() =>
      loadProfiles(envWith("/x"), {
        readFile: () =>
          '[{"id":"a","mcpUrl":"http://x/mcp","mcpToken":"t","mcpCredentials":"/c.json"}]',
      }),
    ).toThrow(/mutually exclusive/);
    expect(() =>
      loadProfiles(envWith("/x"), {
        readFile: () =>
          '[{"id":"a","mcpUrl":"http://x/mcp","mcpToken":"t","cliBin":"my gbrain"}]',
      }),
    ).toThrow(/cliBin/);
  });

  test("error messages never echo a sibling profile's token", () => {
    const file = JSON.stringify([
      { id: "ok", mcpUrl: "http://x/mcp", mcpToken: SECRET },
      { id: "Bad", mcpUrl: "http://x/mcp", mcpToken: "t" },
    ]);
    try {
      loadProfiles(envWith("/x"), { readFile: () => file });
      expect.unreachable();
    } catch (err) {
      const e = err as ConfigError;
      expect(`${e.message}${e.hint}`).not.toContain(SECRET);
    }
  });
});

describe("loadProfiles — OAuth credentials file", () => {
  const dir = join(tmpdir(), `cockpit-profiles-test-${Date.now()}`);

  async function writeCred(name: string, body: unknown, mode = 0o600) {
    await mkdir(dir, { recursive: true });
    const path = join(dir, name);
    await writeFile(path, JSON.stringify(body), { mode });
    return path;
  }

  const cred = {
    version: 1,
    mcp_url: "http://127.0.0.1:3132/mcp",
    issuer_url: "http://127.0.0.1:3132",
    client_id: "ci-123",
    client_secret: "cs-456",
    access_token: "at-789",
    expires_at: Math.floor(Date.now() / 1000) + 3600,
  };

  test("parses the handoff into an in-memory credential", () => {
    const path = "/cred.json";
    const fakeLstat = () => ({
      isSymbolicLink: false,
      isFile: true,
      size: 300,
      mode: 0o600,
    });
    const cfg = loadProfiles(envWith("/x"), {
      lstat: fakeLstat,
      readFile: (p) =>
        p === path
          ? JSON.stringify(cred)
          : JSON.stringify([
              { id: "bip", mcpUrl: "http://x/mcp", mcpCredentials: path },
            ]),
    });
    const p = cfg.profiles[0]!;
    expect(p.mcpToken).toBeUndefined();
    expect(p.oauth).toBeDefined();
    expect(p.oauth!.clientId).toBe("ci-123");
    expect(p.oauth!.clientSecret).toBe("cs-456");
    expect(p.oauth!.issuerUrl).toBe("http://127.0.0.1:3132");
    expect(p.oauth!.accessToken).toBe("at-789");
    expect(p.oauth!.expiresAt).toBe(cred.expires_at);
  });

  test("missing required fields fail closed without echoing the secret", async () => {
    const path = await writeCred("bad.json", { ...cred, client_secret: undefined });
    try {
      loadProfiles(envWith("/x"), {
        readFile: () =>
          JSON.stringify([
            { id: "bip", mcpUrl: "http://x/mcp", mcpCredentials: path },
          ]),
      });
      expect.unreachable();
    } catch (err) {
      const e = err as ConfigError;
      expect(`${e.message}${e.hint}`).not.toContain("cs-456");
    }
    await unlink(path).catch(() => {});
  });

  test("symlinked credential files are refused", async () => {
    await mkdir(dir, { recursive: true });
    const real = await writeCred("real.json", cred);
    const link = join(dir, "link.json");
    try {
      await unlink(link);
    } catch {
      /* absent */
    }
    await symlink(real, link);
    expect(() =>
      loadProfiles(envWith("/x"), {
        readFile: () =>
          JSON.stringify([
            { id: "bip", mcpUrl: "http://x/mcp", mcpCredentials: link },
          ]),
      }),
    ).toThrow(ConfigError);
  });
});
