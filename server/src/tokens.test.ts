import { afterEach, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError } from "./config";
import {
  EMPTY_REGISTRY_TEXT,
  TokenNotFoundError,
  TokenRegistry,
  TokenRegistryError,
  TokenValidationError,
  isReservedTokenName,
  type TokenRegistryDeps,
  nameSkeleton,
  normalizeTokenName,
} from "./tokens";

// The named-token registry (ROADMAP-named-tokens §3.1): what loads, what is
// refused, and the audit-first write order. Real files under the temp dir —
// the checks under test ARE filesystem checks (mode, owner, symlink, lock).

const BRAINS = new Set(["atlas", "bip"]);
const dirs: string[] = [];
const registries: TokenRegistry[] = [];

function registryFile(init = EMPTY_REGISTRY_TEXT, mode = 0o600): string {
  const dir = mkdtempSync(join(tmpdir(), "cockpit-tokens-"));
  dirs.push(dir);
  const file = join(dir, "tokens.json");
  writeFileSync(file, init, { mode });
  chmodSync(file, mode);
  return file;
}

function load(file: string, deps: TokenRegistryDeps = {}) {
  const reg = TokenRegistry.load(file, { knownBrains: () => BRAINS, ...deps });
  registries.push(reg);
  return reg;
}

afterEach(() => {
  while (registries.length) registries.pop()!.dispose();
  for (const dir of dirs.splice(0)) {
    try {
      chmodSync(dir, 0o700);
    } catch {
      // already gone
    }
  }
});

describe("token names (appendix B8)", () => {
  test("ordinary names normalize and keep their characters", () => {
    expect(normalizeTokenName("张三")).toBe("张三");
    expect(normalizeTokenName("Zhang San")).toBe("Zhang San");
    expect(normalizeTokenName("  li.si·wang  ")).toBe("li.si·wang");
    expect(normalizeTokenName("张  三")).toBe("张 三"); // whitespace folds
  });

  test("look-alikes that would impersonate the owner are rejected", () => {
    for (const bad of [
      "Owner",
      "owner (admin)",
      "owner_2",
      "0wner",
      "own3r",
      "adm1n",
      "4dm1n",
      "admln",
      "adrnin", // rn reads as m
      "ovvner", // vv reads as w
      "root",
      "管理员",
      "业主",
      "ｏｗｎｅｒ", // fullwidth → NFKC folds to "owner"
      "admin",
      "Admin Zhang",
    ]) {
      expect(isReservedTokenName(bad)).toBe(true);
    }
  });

  test("characters outside Han/Latin/digits/space/punctuation never pass the whitelist", () => {
    for (const bad of [
      "оwner", // Cyrillic o
      "张\u3164三", // Hangul filler renders blank
      "张\u200b三", // zero-width space
      "a\u202eb", // RTL override
      "José", // accented Latin — documented limitation
      "张三<script>",
    ]) {
      expect(normalizeTokenName(bad)).toBeNull();
    }
  });

  test("length and letter rules", () => {
    expect(normalizeTokenName("")).toBeNull();
    expect(normalizeTokenName("...")).toBeNull(); // no letter
    expect(normalizeTokenName("12345")).toBeNull();
    expect(normalizeTokenName("a".repeat(40))).toBe("a".repeat(40));
    expect(normalizeTokenName("a".repeat(41))).toBeNull();
    expect(normalizeTokenName(42)).toBeNull();
  });

  test("the skeleton folds digits and separators", () => {
    expect(nameSkeleton("0wner-2")).toBe("owner2");
    // l and 1 both fold to i, so the i in "admin" cannot be stood in for
    expect(nameSkeleton("Li Si")).toBe("iisi");
    expect(nameSkeleton("adm1n")).toBe("admin");
    expect(nameSkeleton("admln")).toBe("admin");
    expect(nameSkeleton("4dm1n")).toBe("admin");
    expect(nameSkeleton("adrnin")).toBe("admin");
    expect(nameSkeleton("0vvner")).toBe("owner");
  });
});

describe("TokenRegistry: issue, verify, revoke", () => {
  test("an issued token verifies by digest; nothing else does", async () => {
    const reg = load(registryFile());
    const { token, record } = await reg.issue(
      { name: "张三", brains: ["bip"], adjudicate: true },
      "owner (admin)",
    );
    expect(token).toMatch(/^ck_[A-Za-z0-9_-]{43}$/);
    expect(record.id).toMatch(/^tk_[0-9a-f]{12}$/);
    expect(JSON.stringify(record)).not.toContain(token);
    expect("hash" in record).toBe(false);

    const entry = reg.verify(`Bearer ${token}`);
    expect(entry?.name).toBe("张三");
    expect(entry?.brains).toEqual(["bip"]);
    expect(entry?.adjudicate).toBe(true);
    expect(reg.verify(`Bearer ${token.slice(0, -1)}x`)).toBeNull();
    expect(reg.verify(`Bearer ${token} `)).toBeNull();
    expect(reg.verify(token)).toBeNull(); // scheme missing
    expect(reg.verify(null)).toBeNull();
  });

  test("the file on disk holds the digest, never the plaintext", async () => {
    const file = registryFile();
    const reg = load(file);
    const { token } = await reg.issue(
      { name: "张三", brains: ["bip"], adjudicate: false },
      "owner (admin)",
    );
    const disk = readFileSync(file, "utf8");
    expect(disk).not.toContain(token);
    expect(disk).toMatch(/"hash": "[0-9a-f]{64}"/);
    expect((lstatSync(file).mode & 0o777).toString(8)).toBe("600");
  });

  test("two tokens for one person need distinct names; confusables count as the same", async () => {
    const reg = load(registryFile());
    await reg.issue({ name: "张三", brains: ["bip"], adjudicate: false }, "o");
    await expect(
      reg.issue({ name: "张 三", brains: ["bip"], adjudicate: false }, "o"),
    ).rejects.toBeInstanceOf(TokenValidationError);
    await reg.issue({ name: "张三-手机", brains: ["bip"], adjudicate: false }, "o");
    expect(reg.list().filter((t) => t.revokedAt === null)).toHaveLength(2);
  });

  test("validation errors name the field and never touch the file", async () => {
    const file = registryFile();
    const reg = load(file);
    const before = readFileSync(file, "utf8");
    const bad = [
      { name: "Owner", brains: ["bip"], adjudicate: false },
      { name: "李四", brains: [], adjudicate: false },
      { name: "李四", brains: ["nope"], adjudicate: false },
      { name: "李四", brains: ["BAD ID"], adjudicate: false },
      { name: "李四", brains: ["bip"], adjudicate: "yes" },
      { name: "李四", brains: ["bip"], adjudicate: false, editSources: ["metadata"] },
    ];
    for (const input of bad) {
      await expect(reg.issue(input, "o")).rejects.toBeInstanceOf(TokenValidationError);
    }
    expect(readFileSync(file, "utf8")).toBe(before);
    expect(reg.list()).toHaveLength(0);
  });

  test("revoke is immediate, idempotent and final", async () => {
    const reg = load(registryFile());
    const a = await reg.issue({ name: "甲", brains: ["bip"], adjudicate: true }, "o");
    const b = await reg.issue({ name: "乙", brains: ["bip"], adjudicate: true }, "o");
    const revoked = await reg.revoke(a.record.id, "owner (admin)");
    expect(revoked.revokedAt).not.toBeNull();
    expect(reg.verify(`Bearer ${a.token}`)).toBeNull();
    expect(reg.verify(`Bearer ${b.token}`)?.name).toBe("乙");
    // a second revoke answers success; the tombstone stays
    expect((await reg.revoke(a.record.id, "owner (admin)")).revokedAt).toBe(revoked.revokedAt);
    // dead tokens cannot be revived by re-granting
    await expect(
      reg.setGrants(a.record.id, { brains: ["bip"], adjudicate: true, editSources: [] }, "o"),
    ).rejects.toBeInstanceOf(TokenNotFoundError);
    await expect(reg.revoke("tk_000000000000", "o")).rejects.toBeInstanceOf(TokenNotFoundError);
    // a malformed id is the caller's mistake (400), not a missing token (404)
    await expect(reg.revoke("not-an-id", "o")).rejects.toBeInstanceOf(TokenValidationError);
  });

  test("setGrants replaces the whole sheet and takes effect on the next verify", async () => {
    const reg = load(registryFile());
    const { token, record } = await reg.issue(
      { name: "丙", brains: ["bip"], adjudicate: false },
      "o",
    );
    await reg.setGrants(record.id, { brains: ["atlas", "bip"], adjudicate: true, editSources: [] }, "o");
    const entry = reg.verify(`Bearer ${token}`);
    expect(entry?.adjudicate).toBe(true);
    expect(entry?.brains).toEqual(["atlas", "bip"]);
    await expect(
      reg.setGrants(record.id, { brains: ["nope"], adjudicate: true, editSources: [] }, "o"),
    ).rejects.toBeInstanceOf(TokenValidationError);
  });

  test("list shows active first and never a hash", async () => {
    const reg = load(registryFile());
    const a = await reg.issue({ name: "甲", brains: ["bip"], adjudicate: false }, "o");
    await reg.issue({ name: "乙", brains: ["bip"], adjudicate: false }, "o");
    await reg.revoke(a.record.id, "o");
    const rows = reg.list();
    expect(rows.map((r) => r.name)).toEqual(["乙", "甲"]);
    expect(JSON.stringify(rows)).not.toMatch(/[0-9a-f]{64}/);
  });
});

describe("TokenRegistry: loading fails closed", () => {
  /** one registry row — the callers wrap it in the envelope */
  const row = (extra = "") =>
    `{"id":"tk_0123456789ab","name":"甲","hash":"${"a".repeat(64)}","brains":["bip"],"adjudicate":false,"editSources":[],"createdAt":"2026-11-27T00:00:00.000Z","createdBy":"owner (admin)","revokedAt":null,"revokedBy":null,"lastUsedAt":null${extra}}`;

  test("a missing file is a config error with the bootstrap content in the hint", () => {
    const dir = mkdtempSync(join(tmpdir(), "cockpit-tokens-"));
    dirs.push(dir);
    try {
      TokenRegistry.load(join(dir, "tokens.json"), { knownBrains: () => BRAINS });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).hint).toContain('"version":1,"tokens":[]');
    }
  });

  test("malformed files refuse the boot without echoing contents", () => {
    const secret = "S<cr>et-V@lue"; // characters no name may carry
    const cases: Array<[string, RegExp]> = [
      ["not json", /not JSON/],
      ["[]", /top level/],
      [`{"version":2,"tokens":[]}`, /version/],
      [`{"version":1,"tokens":{}}`, /array/],
      [`{"version":1,"tokens":[],"x":1}`, /unknown top-level/],
      [`{"version":1,"tokens":[${row(`,"surprise":"${secret}"`)}]}`, /unknown field/],
      [`{"version":1,"tokens":[${row().replace('"brains":["bip"],', '"brains":[],')}]}`, /at least one brain/],
      [`{"version":1,"tokens":[${row().replace('"adjudicate":false', '"adjudicate":"${secret}"')}]}`, /adjudicate/],
      [`{"version":1,"tokens":[${row().replace('"name":"甲"', `"name":"${secret}"`)}]}`, /canonical form|reserved/],
      [`{"version":1,"tokens":[${row()}, ${row()}]}`, /duplicate token id/],
    ];
    for (const [text, want] of cases) {
      try {
        TokenRegistry.load(registryFile(text), { knownBrains: () => BRAINS });
        throw new Error(`should have refused: ${text.slice(0, 40)}`);
      } catch (err) {
        expect(err).toBeInstanceOf(ConfigError);
        expect((err as ConfigError).message + (err as ConfigError).hint).toMatch(want);
        expect(((err as ConfigError).message + (err as ConfigError).hint)).not.toContain(secret);
      }
    }
  });

  test("a symlink in place of the file is refused", () => {
    const dir = mkdtempSync(join(tmpdir(), "cockpit-tokens-"));
    dirs.push(dir);
    const real = join(dir, "real.json");
    writeFileSync(real, EMPTY_REGISTRY_TEXT, { mode: 0o600 });
    symlinkSync(real, join(dir, "tokens.json"));
    expect(() =>
      TokenRegistry.load(join(dir, "tokens.json"), { knownBrains: () => BRAINS }),
    ).toThrow(/symbolic link/);
  });

  test("a file others may write is refused; one others may only read loads", () => {
    expect(() =>
      TokenRegistry.load(registryFile(EMPTY_REGISTRY_TEXT, 0o666), { knownBrains: () => BRAINS }),
    ).toThrow(/writable by group or others/);
    const reg = TokenRegistry.load(registryFile(EMPTY_REGISTRY_TEXT, 0o644), {
      knownBrains: () => BRAINS,
    });
    registries.push(reg);
    expect(reg.list()).toHaveLength(0);
  });

  test("one server per registry: a second load on the same file is refused until disposed", () => {
    const file = registryFile();
    const first = load(file);
    expect(() => TokenRegistry.load(file, { knownBrains: () => BRAINS })).toThrow(
      /already holds|already using/,
    );
    first.dispose();
    registries.pop();
    const second = load(file);
    expect(existsSync(`${file}.lock`)).toBe(true);
    second.dispose();
    registries.pop();
    expect(existsSync(`${file}.lock`)).toBe(false);
  });

  test("a valid file round-trips and reports brains that are gone", () => {
    const gone = `{"version":1,"tokens":[{"id":"tk_0123456789ab","name":"甲","hash":"${"a".repeat(64)}","brains":["ghost"],"adjudicate":false,"editSources":[],"createdAt":"2026-11-27T00:00:00.000Z","createdBy":"owner (admin)","revokedAt":null,"revokedBy":null,"lastUsedAt":null}]}`;
    const reg = load(registryFile(gone));
    expect(reg.unknownBrains()).toEqual(["ghost"]);
    expect(reg.verify("Bearer nope")).toBeNull();
  });
});

describe("TokenRegistry: write order", () => {
  test("audit first — an unwritable audit leaves the registry untouched", async () => {
    const file = registryFile();
    const before = readFileSync(file, "utf8");
    const reg = load(file, {
      auditStrict: async () => {
        throw new Error("disk full");
      },
    });
    await expect(
      reg.issue({ name: "丁", brains: ["bip"], adjudicate: false }, "o"),
    ).rejects.toThrow("disk full"); // the audit error surfaces as-is
    expect(readFileSync(file, "utf8")).toBe(before);
    expect(reg.list()).toHaveLength(0);
  });

  test("a failed persist changes nothing in memory and leaves a compensation line", async () => {
    const file = registryFile();
    const soft: string[] = [];
    const reg = load(file, {
      auditStrict: async () => undefined,
      auditSoft: async (action) => {
        soft.push(action);
      },
    });
    const before = readFileSync(file, "utf8");
    chmodSync(join(file, ".."), 0o500); // the directory can no longer take a temp file
    try {
      await expect(
        reg.issue({ name: "丁", brains: ["bip"], adjudicate: false }, "o"),
      ).rejects.toBeInstanceOf(TokenRegistryError);
    } finally {
      chmodSync(join(file, ".."), 0o700);
    }
    expect(reg.list()).toHaveLength(0);
    expect(readFileSync(file, "utf8")).toBe(before);
    expect(soft).toEqual(["token.issue.failed"]);
  });

  test("a hand edit underneath a running server is never overwritten", async () => {
    const file = registryFile();
    const reg = load(file);
    appendFileSync(file, "\n");
    await expect(
      reg.issue({ name: "丁", brains: ["bip"], adjudicate: false }, "o"),
    ).rejects.toThrow(/changed underneath/);
    expect(reg.list()).toHaveLength(0);
  });

  test("the strict audit runs before the file changes and sees the sheet, not the token", async () => {
    const file = registryFile();
    const seen: Array<{ action: string; detail: Record<string, unknown> }> = [];
    let diskAtAudit = "";
    const reg = load(file, {
      auditStrict: async (action, detail) => {
        seen.push({ action, detail });
        diskAtAudit = readFileSync(file, "utf8");
      },
    });
    const { token } = await reg.issue(
      { name: "戊", brains: ["bip"], adjudicate: true },
      "owner (admin)",
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]!.action).toBe("token.issue");
    expect(JSON.stringify(seen[0]!.detail)).not.toContain(token);
    expect(diskAtAudit).toBe(EMPTY_REGISTRY_TEXT); // not yet persisted
  });
});

describe("TokenRegistry: size bounds", () => {
  test("a file past the hard cap is not a registry cockpit wrote — refused at boot", () => {
    const dir = mkdtempSync(join(tmpdir(), "cockpit-tokens-"));
    dirs.push(dir);
    const file = join(dir, "tokens.json");
    writeFileSync(file, "x".repeat(4 * 1024 * 1024 + 1), { mode: 0o600 });
    expect(() => TokenRegistry.load(file, { knownBrains: () => BRAINS })).toThrow(/exceeds/);
  });

  test("revoked rows past their keep window are pruned on the next write; fresh ones stay", async () => {
    const old = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000).toISOString();
    const file = registryFile(
      `{"version":1,"tokens":[${`{"id":"tk_000000000001","name":"旧甲","hash":"${"a".repeat(64)}","brains":["bip"],"adjudicate":false,"editSources":[],"createdAt":"2026-01-01T00:00:00.000Z","createdBy":"owner (admin)","revokedAt":"${old}","revokedBy":"owner (admin)","lastUsedAt":null}`}] }\n`.replace("] }", "]}"),
    );
    const reg = load(file);
    expect(reg.list()).toHaveLength(1);
    const fresh = await reg.issue({ name: "乙", brains: ["bip"], adjudicate: false }, "o");
    await reg.revoke(fresh.record.id, "owner (admin)");
    expect(reg.list().map((r) => r.name)).toEqual(["乙"]);
    // and it is gone on disk too, not just in memory
    expect(readFileSync(file, "utf8")).not.toContain("tk_000000000001");
  });
});

describe("TokenRegistry: hardened after the implementation review", () => {
  const row = (id: string, name: string, extra = "") =>
    `{"id":"${id}","name":"${name}","hash":"${"a".repeat(64)}","brains":["bip"],"adjudicate":false,"editSources":[],"createdAt":"2026-01-01T00:00:00.000Z","createdBy":"owner (admin)","revokedAt":null,"revokedBy":null,"lastUsedAt":null${extra}}`;

  test("a hand-edited edit grant is refused at boot, not honored", () => {
    const withEdit = `{"version":1,"tokens":[${row("tk_0123456789ab", "甲").replace('"editSources":[]', '"editSources":["default"]')}]}\n`;
    try {
      TokenRegistry.load(registryFile(withEdit), { knownBrains: () => BRAINS });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).hint).toMatch(/editSources must be empty/);
    }
  });

  test("the re-grant and revoke edges: a malformed id and a missing editSources are the caller's mistake", async () => {
    const reg = load(registryFile());
    const { record } = await reg.issue({ name: "乙", brains: ["bip"], adjudicate: false }, "o");
    await expect(reg.revoke("nope", "o")).rejects.toBeInstanceOf(TokenValidationError);
    await expect(reg.setGrants("nope", { brains: ["bip"], adjudicate: true, editSources: [] }, "o")).rejects.toBeInstanceOf(
      TokenValidationError,
    );
    // the sheet is always sent whole — an absent editSources never clears it silently
    await expect(
      reg.setGrants(record.id, { brains: ["bip"], adjudicate: true, editSources: undefined }, "o"),
    ).rejects.toBeInstanceOf(TokenValidationError);
    expect(reg.verify("Bearer nope")).toBeNull();
    expect(reg.list()[0]!.adjudicate).toBe(false);
  });

  test("a directory others may write (group or everyone) is refused", () => {
    for (const mode of [0o775, 0o770, 0o777]) {
      const dir = mkdtempSync(join(tmpdir(), "cockpit-tokens-"));
      dirs.push(dir);
      const file = join(dir, "tokens.json");
      writeFileSync(file, EMPTY_REGISTRY_TEXT, { mode: 0o600 });
      chmodSync(dir, mode);
      try {
        expect(() => TokenRegistry.load(file, { knownBrains: () => BRAINS })).toThrow(/writable by others/);
      } finally {
        chmodSync(dir, 0o700);
      }
    }
  });

  test("a stale lock is taken over; a lock held by a live process is not", () => {
    const file = registryFile();
    // a pid that does not exist: spawn something, keep its exit, and reuse a huge number
    const deadPid = 4_000_000 + Math.floor(Math.random() * 100_000);
    const alive = (() => {
      try {
        process.kill(deadPid, 0);
        return true;
      } catch {
        return false;
      }
    })();
    if (!alive) {
      writeFileSync(`${file}.lock`, `${deadPid} deadbeef`, { mode: 0o600 });
      const reg = load(file); // takes the stale lock over
      expect(readLock(file)).toMatch(new RegExp(`^${process.pid} `));
      registries.pop();
      reg.dispose();
    }
    // a live holder: this very process looks alive from its own point of view
    writeFileSync(`${file}.lock`, `${process.pid} someoneelse`, { mode: 0o600 });
    expect(() => TokenRegistry.load(file, { knownBrains: () => BRAINS })).toThrow(/already holds/);
    // an empty lock is "being written": a contender WAITS out the grace
    // period instead of grabbing at once (that grab was the double-hold)
    writeFileSync(`${file}.lock`, "", { mode: 0o600 });
    let waited: TokenRegistry | null = null;
    const started = performance.now();
    expect(() => {
      waited = TokenRegistry.load(file, { knownBrains: () => BRAINS, lockGraceMs: 400 });
    }).not.toThrow();
    expect(performance.now() - started).toBeGreaterThanOrEqual(400);
    registries.push(waited!);
    expect(readLock(file)).toMatch(new RegExp(`^${process.pid} `));
    // …while an empty lock abandoned long ago is taken over at once
    registries.pop();
    waited!.dispose();
    writeFileSync(`${file}.lock`, "", { mode: 0o600 });
    const abandoned = performance.now();
    const past = new Date(Date.now() - 60_000);
    utimesSync(`${file}.lock`, past, past);
    const quick = TokenRegistry.load(file, { knownBrains: () => BRAINS, lockGraceMs: 400 });
    registries.push(quick);
    expect(performance.now() - abandoned).toBeLessThan(300);
  });

  test("a last-used flush queued behind a mid-flight revoke never resurrects the revoked token on disk", async () => {
    const file = registryFile();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const inAudit = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const reg = load(file, {
      auditStrict: async (action) => {
        if (action === "token.revoke") {
          entered();
          await gate; // the commit parks here, mid-flight
        }
      },
    });
    const { token, record } = await reg.issue({ name: "丙", brains: ["bip"], adjudicate: false }, "o");
    const realNow = Date.now;
    let offset = 0;
    Date.now = () => realNow() + offset;
    try {
      const revoking = reg.revoke(record.id, "owner (admin)");
      await inAudit;
      offset = 2 * 60 * 60 * 1000; // two hours pass: the hourly flush window opens
      expect(reg.verify(`Bearer ${token}`)?.name).toBe("丙"); // queues the flush behind the commit
      release();
      await revoking;
      await new Promise((resolve) => setTimeout(resolve, 60)); // let the queued flush run
    } finally {
      Date.now = realNow;
    }
    expect(reg.verify(`Bearer ${token}`)).toBeNull(); // memory
    reg.dispose();
    registries.pop();
    const reloaded = load(file); // and a fresh process would read the same
    expect(reloaded.verify(`Bearer ${token}`)).toBeNull();
  });
});

function readLock(file: string): string {
  return readFileSync(`${file}.lock`, "utf8");
}
