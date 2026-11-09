import { describe, expect, test } from "bun:test";
import {
  buildScopedEnv,
  buildTakeQueueCommands,
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

describe("buildScopedEnv", () => {
  test("source-scoped form: source+home set, instance vars stripped", () => {
    const env = buildScopedEnv(
      {
        PATH: "/usr/bin",
        GBRAIN_SOURCE: "stale-from-shell",
        GBRAIN_BRAIN_ID: "other-brain",
        HOME: "/home/op",
      },
      { sourceId: "mail-import", gbrainHome: "/srv/brain-bip-home" },
    );
    expect(env.GBRAIN_SOURCE).toBe("mail-import");
    expect(env.GBRAIN_HOME).toBe("/srv/brain-bip-home");
    expect(env.GBRAIN_BRAIN_ID).toBeUndefined(); // wrapper unsets BOTH vars
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/home/op");
  });

  test("brain-scoped form (0.4.0 management execs): home set, NO source pin", () => {
    const env = buildScopedEnv(
      { PATH: "/usr/bin", GBRAIN_SOURCE: "leaked-from-shell", GBRAIN_BRAIN_ID: "x" },
      { gbrainHome: "/srv/brain-bip-home" },
    );
    expect(env.GBRAIN_SOURCE).toBeUndefined(); // auth/sources/doctor verbs are whole-brain
    expect(env.GBRAIN_HOME).toBe("/srv/brain-bip-home");
    expect(env.GBRAIN_BRAIN_ID).toBeUndefined();
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

  test("brainExec (0.4.0): same assertion, home-scoped env with no source pin", async () => {
    const { guard, files } = makeGuard();
    files.set("/srv/brain-bip-home/.gbrain/config.json", CONFIG("bip"));
    const scoped = await guard.brainExec();
    expect(scoped.bin).toBe("/opt/gbrain-real/gbrain");
    expect(scoped.env.GBRAIN_HOME).toBe("/srv/brain-bip-home");
    expect(scoped.env.GBRAIN_SOURCE).toBeUndefined();
    expect(scoped.env.GBRAIN_BRAIN_ID).toBeUndefined();
  });

  test("brainExec refuses on the same database mismatch as scopedExec", async () => {
    const { guard, files } = makeGuard({ expectedDb: "bip" });
    files.set("/srv/brain-bip-home/.gbrain/config.json", CONFIG("postgres"));
    await expect(guard.brainExec()).rejects.toBeInstanceOf(TakesSourceGuardError);
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

  test("home getter exposes the pair copy-command templates need", () => {
    const { guard } = makeGuard();
    expect(guard.home).toBe("/srv/brain-bip-home");
  });
});

describe("buildTakeQueueCommands", () => {
  const guard = { bin: "/opt/gbrain-real/gbrain", home: "/srv/brain-bip-home" };

  test("direct-call pair: every source gets the scoped {id} template, default included", () => {
    const cmds = buildTakeQueueCommands(
      [
        { source_id: "yon-bip" },
        { source_id: "default" },
        { source_id: "yon-bip" },
      ],
      { cliBin: "gbrain-bip", guard },
    );
    expect(Object.keys(cmds.bySource).sort()).toEqual(["default", "yon-bip"]);
    expect(cmds.bySource["yon-bip"]!.accept).toBe(
      "GBRAIN_SOURCE=yon-bip GBRAIN_HOME=/srv/brain-bip-home /opt/gbrain-real/gbrain takes propose --accept {id}",
    );
    expect(cmds.bySource["yon-bip"]!.reject).toBe(
      "GBRAIN_SOURCE=yon-bip GBRAIN_HOME=/srv/brain-bip-home /opt/gbrain-real/gbrain takes propose --reject {id}",
    );
    expect(cmds.bySource["default"]!.accept).toContain("GBRAIN_SOURCE=default");
    expect(cmds.unavailable).toEqual([]);
  });

  test("no pair, single-source brain: plain wrapper form for default rows", () => {
    const cmds = buildTakeQueueCommands(
      [{ source_id: "default" }, {}], // no source_id lands under "default" too
      { cliBin: "gbrain" },
    );
    expect(cmds.bySource["default"]!.accept).toBe(
      "gbrain takes propose --accept {id}",
    );
    expect(cmds.bySource["default"]!.reject).toBe(
      "gbrain takes propose --reject {id}",
    );
    expect(cmds.unavailable).toEqual([]);
  });

  test("no pair, non-default source: NO command — the source is named unavailable", () => {
    // the 0.2.2 bug, degraded form: pasting the wrapper command here is a
    // guaranteed not_found, so the template set must refuse to build one
    const cmds = buildTakeQueueCommands([{ source_id: "yon-bip" }], {
      cliBin: "gbrain-bip",
    });
    expect(cmds.bySource).toEqual({});
    expect(cmds.unavailable).toEqual(["yon-bip"]);
  });

  test("shell-hostile guard materials fall back instead of building paste text", () => {
    const cmds = buildTakeQueueCommands([{ source_id: "yon-bip" }], {
      cliBin: "gbrain",
      guard: { bin: "/opt/gbrain $(rm -rf /)", home: "/srv/brain-bip-home" },
    });
    expect(cmds.bySource).toEqual({});
    expect(cmds.unavailable).toEqual(["yon-bip"]);
  });

  test("empty queue yields an empty template set", () => {
    const cmds = buildTakeQueueCommands([], { cliBin: "gbrain" });
    expect(cmds.bySource).toEqual({});
    expect(cmds.unavailable).toEqual([]);
  });
});
