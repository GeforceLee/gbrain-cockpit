import { describe, expect, test } from "bun:test";
import {
  buildScopedTakesEnv,
  dbBasename,
  TakesActionGuard,
  TakesSourceGuardError,
} from "./takes-source";

// The guard replicates the isolated-brain wrapper's safety assertion
// (an isolated-brain wrapper: unset GBRAIN_SOURCE, export GBRAIN_HOME, verify
// <home>/.gbrain/config.json's database_url names THIS brain's database,
// then exec the real binary). Everything here runs against injected
// readFile/env — no filesystem, no real DSNs.

describe("dbBasename", () => {
  test("extracts the database name from postgres URLs", () => {
    expect(dbBasename("postgresql://cockpit_ro:secret@127.0.0.1:5432/bip")).toBe("bip");
    expect(dbBasename("postgres://u:p@h/db")).toBe("db");
    expect(dbBasename("postgresql://u:p@h:5432/postgres?sslmode=require")).toBe("postgres");
    // the wrapper's own comparison shape: */bip
    expect(dbBasename("postgresql://u:p@localhost/bip")).toBe("bip");
  });

  test("empty for unparseable or non-postgres input — never a guess", () => {
    expect(dbBasename("not a url")).toBe("");
    expect(dbBasename("http://example.com/bip")).toBe("");
    expect(dbBasename("postgresql://u:p@h/")).toBe("");
    expect(dbBasename("")).toBe("");
  });
});

describe("buildScopedTakesEnv", () => {
  test("scopes the child env: source+home set, instance vars stripped", () => {
    const env = buildScopedTakesEnv(
      {
        PATH: "/usr/bin",
        GBRAIN_SOURCE: "stale-from-shell",
        GBRAIN_BRAIN_ID: "other-brain",
        HOME: "/home/op",
      },
      "mail-import",
      "/srv/brain-bip-home",
    );
    expect(env.GBRAIN_SOURCE).toBe("mail-import");
    expect(env.GBRAIN_HOME).toBe("/srv/brain-bip-home");
    expect(env.GBRAIN_BRAIN_ID).toBeUndefined(); // wrapper unsets BOTH vars
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/home/op");
  });
});

function makeGuard(opts?: { expectedDb?: string }) {
  const files = new Map<string, string>();
  const guard = new TakesActionGuard(
    {
      gbrainBin: "/opt/gbrain-real/gbrain",
      gbrainHome: "/srv/brain-bip-home",
      expectedDb: opts?.expectedDb ?? "bip",
    },
    { readFile: async (p) => files.get(p) ?? Promise.reject(new Error("ENOENT")) },
  );
  return { guard, files };
}

const CONFIG = (db: string) =>
  JSON.stringify({ engine: "postgres", database_url: `postgresql://gbrain:pw@127.0.0.1:5432/${db}` });

describe("TakesActionGuard", () => {
  test("matching database passes and hands back bin + scoped env", async () => {
    const { guard, files } = makeGuard();
    files.set("/srv/brain-bip-home/.gbrain/config.json", CONFIG("bip"));
    const scoped = await guard.scopedExec("mail-import");
    expect(scoped.bin).toBe("/opt/gbrain-real/gbrain");
    expect(scoped.env.GBRAIN_SOURCE).toBe("mail-import");
    expect(scoped.env.GBRAIN_HOME).toBe("/srv/brain-bip-home");
  });

  test("database mismatch refuses the exec, naming databases only — never the URL", async () => {
    const { guard, files } = makeGuard({ expectedDb: "bip" });
    files.set("/srv/brain-bip-home/.gbrain/config.json", CONFIG("postgres"));
    try {
      await guard.scopedExec("default");
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(TakesSourceGuardError);
      const message = (err as Error).message;
      expect(message).toContain('"postgres"');
      expect(message).toContain('"bip"');
      expect(message).not.toContain("://"); // no URL, no credentials
      expect(message).not.toContain("pw@");
    }
  });

  test("unreadable or invalid brain config refuses the exec", async () => {
    const missing = makeGuard(); // no file in the map
    await expect(missing.guard.scopedExec("default")).rejects.toBeInstanceOf(
      TakesSourceGuardError,
    );
    const { guard, files } = makeGuard();
    files.set("/srv/brain-bip-home/.gbrain/config.json", "{not json");
    await expect(guard.scopedExec("default")).rejects.toThrow(/cannot read the brain config/);
  });

  test("source_id outside gbrain's GBRAIN_SOURCE charset is refused pre-exec", async () => {
    const { guard, files } = makeGuard();
    files.set("/srv/brain-bip-home/.gbrain/config.json", CONFIG("bip"));
    for (const bad of ["__all__", "Bad_Source", "has space", "x".repeat(33), ""]) {
      await expect(guard.scopedExec(bad)).rejects.toThrow(TakesSourceGuardError);
    }
  });

  test("assertStartup surfaces the same refusal for fail-closed startup", async () => {
    const { guard, files } = makeGuard({ expectedDb: "bip" });
    files.set("/srv/brain-bip-home/.gbrain/config.json", CONFIG("bip"));
    await guard.assertStartup(); // matching → resolves
    files.set("/srv/brain-bip-home/.gbrain/config.json", CONFIG("elsewhere"));
    await expect(guard.assertStartup()).rejects.toThrow(/wrong brain/);
  });
});
