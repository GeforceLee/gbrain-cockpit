import { describe, expect, test } from "bun:test";
import {
  buildArgv,
  CliDriver,
  CliExecutionError,
  CliValidationError,
  locateGbrainBin,
} from "./cli";

describe("buildArgv (whitelist discipline)", () => {
  test("flag-only subcommand", () => {
    expect(buildArgv("trust review", {})).toEqual(["trust", "review", "--json"]);
    expect(buildArgv("edge-proposals list", {})).toEqual([
      "edge-proposals",
      "list",
      "--json",
    ]);
  });

  test("positionals land after the -- separator", () => {
    expect(buildArgv("trust drop", { ref: "tp42" })).toEqual([
      "trust",
      "drop",
      "--",
      "tp42",
    ]);
    expect(
      buildArgv("edge-proposals date", { id: "7", date: "2026-01-02" }),
    ).toEqual(["edge-proposals", "date", "--", "7", "2026-01-02"]);
  });

  test("value flags carry their validated value inline", () => {
    expect(buildArgv("takes propose accept", { id: "606" })).toEqual([
      "takes",
      "propose",
      "--accept",
      "606",
    ]);
    expect(buildArgv("takes propose reject", { id: "606" })).toEqual([
      "takes",
      "propose",
      "--reject",
      "606",
    ]);
  });

  test("the takes propose LIST form is not whitelisted (queue reads the bypass)", () => {
    // gbrain scopes `takes propose` to one source per run — the CLI list
    // hides non-default sources on multi-source brains, so it must not be
    // executable through this driver at all.
    expect(() => buildArgv("takes propose list", { limit: "500" })).toThrow(
      CliValidationError,
    );
  });

  test("decide proposals family: list/accept/reject/undo build exact argv", () => {
    expect(buildArgv("decide proposals list", {})).toEqual([
      "decide",
      "proposals",
      "list",
      "--json",
    ]);
    expect(buildArgv("decide proposals accept", { id: "7" })).toEqual([
      "decide",
      "proposals",
      "accept",
      "--",
      "7",
    ]);
    expect(buildArgv("decide proposals reject", { id: "7" })).toEqual([
      "decide",
      "proposals",
      "reject",
      "--",
      "7",
    ]);
    expect(buildArgv("decide proposals undo", { id: "7" })).toEqual([
      "decide",
      "proposals",
      "undo",
      "--",
      "7",
    ]);
  });

  test("decide proposals verbs reject flag-shaped and non-numeric ids", () => {
    // bare digits only: the dp<id> prefix is a TRUST-review ref shape, while
    // this family takes the bare proposal id (probed 0.60.611)
    expect(() => buildArgv("decide proposals accept", { id: "--all-from" })).toThrow(
      CliValidationError,
    );
    expect(() => buildArgv("decide proposals reject", { id: "7;rm" })).toThrow(
      CliValidationError,
    );
    expect(() => buildArgv("decide proposals undo", { id: "dp7" })).toThrow(
      CliValidationError,
    );
  });

  test("flag injection through any value is impossible", () => {
    expect(() => buildArgv("trust drop", { ref: "--json" })).toThrow(
      CliValidationError,
    );
    expect(() => buildArgv("trust drop", { ref: "-rf" })).toThrow(
      CliValidationError,
    );
    expect(() => buildArgv("trust drop", { ref: "tp1;rm -rf /" })).toThrow(
      CliValidationError,
    );
    expect(() =>
      buildArgv("takes propose accept", { id: "1 --evil" }),
    ).toThrow(CliValidationError);
    expect(() =>
      buildArgv("takes propose reject", { id: "1;evil" }),
    ).toThrow(CliValidationError);
  });

  test("whitelist refs only, by prefix", () => {
    for (const good of ["tp1", "h123", "f1", "a99", "t42"]) {
      expect(() => buildArgv("trust drop", { ref: good })).not.toThrow();
    }
    for (const bad of ["x1", "TP1", "tp", "tp" + "9".repeat(19), ""]) {
      expect(() => buildArgv("trust drop", { ref: bad })).toThrow(
        CliValidationError,
      );
    }
  });

  test("missing required values are rejected", () => {
    expect(() => buildArgv("trust drop", {})).toThrow(CliValidationError);
    expect(() =>
      buildArgv("edge-proposals date", { id: "7" }),
    ).toThrow(CliValidationError);
    expect(() => buildArgv("takes propose accept", {})).toThrow(
      CliValidationError,
    );
  });

  test("unknown subcommands are rejected before any exec", () => {
    expect(() => buildArgv("trust confirm", { ref: "tp1" })).toThrow(
      CliValidationError,
    );
    expect(() => buildArgv("rm -rf", {})).toThrow(CliValidationError);
    expect(() => buildArgv("edge-proposals retry", { id: "1" })).toThrow(
      CliValidationError,
    );
    expect(() => buildArgv("takes add", {})).toThrow(CliValidationError);
  });
});

function makeDriver(
  handler: (
    bin: string,
    argv: string[],
    env?: Record<string, string>,
  ) => Promise<{ stdout: string; stderr: string }>,
) {
  const calls: { bin: string; argv: string[]; env?: Record<string, string> }[] = [];
  const driver = new CliDriver("/fake/gbrain", {
    exec: async (bin, argv, env) => {
      calls.push({ bin, argv, env });
      return handler(bin, argv, env);
    },
  });
  return { driver, calls };
}

describe("CliDriver", () => {
  test("parses JSON output of review/list", async () => {
    const { driver, calls } = makeDriver(async (_bin, argv) => ({
      stdout: argv.includes("review")
        ? JSON.stringify({ schema_version: 1, items: [], counts: { proposal: 0 } })
        : "[]",
      stderr: "",
    }));
    const review = await driver.trustReview();
    expect(review.counts).toEqual({ proposal: 0 });
    expect(calls[0]).toEqual({
      bin: "/fake/gbrain",
      argv: ["trust", "review", "--json"],
    });
    const edges = await driver.edgeList();
    expect(edges).toEqual([]);
  });

  test("nonzero exit maps to a sanitized error (stderr first line)", async () => {
    const { driver } = makeDriver(async () => {
      throw Object.assign(new Error("failed"), {
        code: 1,
        stderr: "Error: no brain here\npath /home/x/y",
      });
    });
    try {
      await driver.trustDrop("tp1");
      throw new Error("expected CliExecutionError");
    } catch (err) {
      expect(err).toBeInstanceOf(CliExecutionError);
      const e = err as CliExecutionError;
      expect(e.message).toContain("no brain here");
      expect(e.message).not.toContain("/home/x/y"); // paths stay in server logs
      expect(e.exitCode).toBe(1);
    }
  });

  test("ENOENT means binary missing", async () => {
    const { driver } = makeDriver(async () => {
      const err = new Error("nf") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    });
    await expect(driver.trustReview()).rejects.toThrow(/not found/);
  });

  test("killed process reads as timeout", async () => {
    const { driver } = makeDriver(async () => {
      const err = new Error("killed") as NodeJS.ErrnoException & {
        killed?: boolean;
      };
      err.killed = true;
      throw err;
    });
    try {
      await driver.edgeAccept("1");
      throw new Error("expected timeout error");
    } catch (err) {
      expect((err as CliExecutionError).timedOut).toBe(true);
    }
  });

  test("non-JSON stdout on a json command is a protocol error", async () => {
    const { driver } = makeDriver(async () => ({
      stdout: "human readable output",
      stderr: "",
    }));
    await expect(driver.trustReview()).rejects.toThrow(/not JSON/);
  });

  test("concurrency is capped at 2 concurrent execs", async () => {
    let inFlight = 0;
    let peak = 0;
    const { driver } = makeDriver(async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 30));
      inFlight--;
      return { stdout: "[]", stderr: "" };
    });
    await Promise.all([
      driver.edgeList(),
      driver.edgeList(),
      driver.edgeList(),
      driver.edgeList(),
    ]);
    expect(peak).toBeLessThanOrEqual(2);
  });

  test("takes propose accept/reject build whitelisted argv (legacy path: no override)", async () => {
    const { driver, calls } = makeDriver(async () => ({
      stdout: "promoted",
      stderr: "",
    }));
    const accepted = await driver.takesProposeAccept("606");
    expect(accepted.output).toBe("promoted");
    expect(calls[0]?.argv).toEqual(["takes", "propose", "--accept", "606"]);
    expect(calls[0]?.bin).toBe("/fake/gbrain");
    expect(calls[0]?.env).toBeUndefined(); // inherited process env
    expect((await driver.takesProposeReject("606")).output).toBe("promoted");
    expect(calls[1]?.argv).toEqual(["takes", "propose", "--reject", "606"]);
  });

  test("scoped opts swap the binary and hand the exec its own env", async () => {
    const { driver, calls } = makeDriver(async () => ({
      stdout: "promoted",
      stderr: "",
    }));
    const env = {
      PATH: "/usr/bin",
      GBRAIN_SOURCE: "mail-import",
      GBRAIN_HOME: "/srv/brain-bip-home",
    };
    await driver.takesProposeAccept("6", { bin: "/opt/gbrain-real/gbrain", env });
    expect(calls[0]?.bin).toBe("/opt/gbrain-real/gbrain");
    expect(calls[0]?.argv).toEqual(["takes", "propose", "--accept", "6"]);
    expect(calls[0]?.env).toBe(env);
    // the next call without opts is back on the profile's own cliBin
    await driver.takesProposeReject("6");
    expect(calls[1]?.bin).toBe("/fake/gbrain");
    expect(calls[1]?.env).toBeUndefined();
  });

  test("status() reflects probe success and caches it", async () => {
    let probes = 0;
    const { driver } = makeDriver(async () => {
      probes++;
      return { stdout: JSON.stringify({ items: [] }), stderr: "" };
    });
    expect((await driver.status()).available).toBe(true);
    await driver.status();
    expect(probes).toBe(1); // cached
  });

  test("status() unavailable when the probe fails", async () => {
    const { driver } = makeDriver(async () => {
      const err = new Error("x") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    });
    const status = await driver.status();
    expect(status.available).toBe(false);
    expect(status.error).toBeTruthy();
  });
});

describe("locateGbrainBin (per-profile CLI resolution)", () => {
  test("bare command name resolves via PATH (wrapper brains like gbrain-bip)", async () => {
    const bin = await locateGbrainBin("gbrain-bip", {
      which: async (name) =>
        name === "gbrain-bip" ? "/usr/local/bin/gbrain-bip" : null,
      accessX: async () => false,
    });
    expect(bin).toBe("/usr/local/bin/gbrain-bip");
  });

  test("absolute path is X_OK-checked, never PATH-resolved", async () => {
    const bin = await locateGbrainBin("/opt/wrapper", {
      which: async () => "/should-not-be-used",
      accessX: async (p) => p === "/opt/wrapper",
    });
    expect(bin).toBe("/opt/wrapper");
    expect(await locateGbrainBin("/nope", {
      which: async () => null,
      accessX: async () => false,
    })).toBeNull();
  });

  test("unset falls back to the conventional gbrain on PATH", async () => {
    expect(
      await locateGbrainBin(null, { which: async (n) => `/usr/bin/${n}`, accessX: async () => true }),
    ).toBe("/usr/bin/gbrain");
    expect(
      await locateGbrainBin(null, { which: async () => null, accessX: async () => true }),
    ).toBeNull();
  });
});

describe("wrapper stderr banners", () => {
  test("the banner line is skipped when surfacing the real error", async () => {
    const { driver } = makeDriver(async () => {
      const err = new Error("exit 2") as Error & {
        code?: number | string;
        stderr?: string;
      };
      err.code = 2;
      err.stderr = "[gbrain-bip] → postgresql://…/bip\nError: no brain directory configured";
      throw err;
    });
    try {
      await driver.trustReview();
      expect.unreachable();
    } catch (err) {
      expect((err as CliExecutionError).message).toContain(
        "no brain directory configured",
      );
      expect((err as CliExecutionError).message).not.toContain("[gbrain-bip]");
    }
  });
});

// --- 0.4.0 management verbs (probes 2026-11-09, 0.60.558) --------------------

const CLIENT_ID =
  "gbrain_cl_489f6ae02796baf04d3bbb080308b39ec98d8991e1cc9597ed00b8ece4c2c7c9";

describe("management verbs: buildArgv shape", () => {
  test("auth clients and sources list are flag-only JSON reads", () => {
    expect(buildArgv("auth clients", {})).toEqual(["auth", "clients", "--json"]);
    expect(buildArgv("sources list", {})).toEqual(["sources", "list", "--json"]);
  });

  test("auth rescope carries exactly --client + --federated-read", () => {
    expect(
      buildArgv("auth rescope", { clientId: CLIENT_ID, sources: "a,b-c" }),
    ).toEqual(["auth", "rescope", "--client", CLIENT_ID, "--federated-read", "a,b-c"]);
  });

  test("doctor --only is locked to the cycle_freshness check id", () => {
    expect(buildArgv("doctor cycle freshness", { check: "cycle_freshness" })).toEqual([
      "doctor",
      "--only",
      "cycle_freshness",
      "--json",
    ]);
    // any other check id — including upstream's slow/heavy checks — is refused
    expect(() =>
      buildArgv("doctor cycle freshness", { check: "persistence_capacity" }),
    ).toThrow(CliValidationError);
    expect(() =>
      buildArgv("doctor cycle freshness", { check: "all" }),
    ).toThrow(CliValidationError);
  });

  test("injection shapes are refused: rescope values", () => {
    // client id must be gbrain's minted shape
    for (const bad of ["../../etc", "cl_abc", "gbrain_cl_", `gbrain_cl_${"z".repeat(64)}`, "--token"]) {
      expect(() =>
        buildArgv("auth rescope", { clientId: bad, sources: "a" }),
      ).toThrow(CliValidationError);
    }
    // federated list: leading dash, empty segment, flag-shaped value, whitespace
    for (const bad of ["-a", "a,,b", "--json", "a b", "A,B", "a;b"]) {
      expect(() =>
        buildArgv("auth rescope", { clientId: CLIENT_ID, sources: bad }),
      ).toThrow(CliValidationError);
    }
  });

  test("legacy-token reshaping forms of rescope are structurally unreachable", () => {
    // upstream's real verb also takes --token/--takes-holders; the spec has
    // no slot for them, so they can only arrive as a VALUE and die on regex
    expect(() =>
      buildArgv("auth rescope", { clientId: CLIENT_ID, sources: "--takes-holders world" }),
    ).toThrow(CliValidationError);
    expect(() =>
      buildArgv("auth rescope --token t", { clientId: CLIENT_ID, sources: "a" }),
    ).toThrow(/not whitelisted/);
  });

  test("missing values are rejected", () => {
    expect(() => buildArgv("auth rescope", { clientId: CLIENT_ID })).toThrow(
      CliValidationError,
    );
    expect(() => buildArgv("auth rescope", { sources: "a" })).toThrow(
      CliValidationError,
    );
  });
});

describe("management verbs: CliDriver", () => {
  test("authClients parses the clients envelope", async () => {
    const { driver, calls } = makeDriver(async () => ({
      stdout: JSON.stringify({
        window_days: 30,
        clients: [{ client_id: CLIENT_ID, federated_read: ["a", "b"] }],
      }),
      stderr: "",
    }));
    const out = await driver.authClients();
    expect(out.clients?.[0]?.client_id).toBe(CLIENT_ID);
    expect(calls[0]!.argv).toEqual(["auth", "clients", "--json"]);
  });

  test("authRescope validates the list before any exec (union shape, deduped)", async () => {
    const { driver, calls } = makeDriver(async () => ({
      stdout: "OAuth client rescoped: cockpit-ui",
      stderr: "",
    }));
    await driver.authRescope(CLIENT_ID, ["a", "b", "a"]);
    expect(calls[0]!.argv).toEqual([
      "auth",
      "rescope",
      "--client",
      CLIENT_ID,
      "--federated-read",
      "a,b",
    ]);
    await expect(driver.authRescope(CLIENT_ID, [])).rejects.toThrow();
    await expect(driver.authRescope(CLIENT_ID, ["--evil"])).rejects.toThrow();
  });

  test("authRescope routes through the scoped exec when the guard provides one", async () => {
    const { driver, calls } = makeDriver(async () => ({ stdout: "ok", stderr: "" }));
    await driver.authRescope(CLIENT_ID, ["a"], {
      bin: "/real/gbrain",
      env: { GBRAIN_HOME: "/home/dev/gbrain-bip" },
    });
    expect(calls[0]!.bin).toBe("/real/gbrain");
    expect(calls[0]!.env?.GBRAIN_HOME).toBe("/home/dev/gbrain-bip");
  });

  test("sourcesListJson parses the owner-view registry incl. archived", async () => {
    const { driver } = makeDriver(async () => ({
      stdout: JSON.stringify({
        sources: [
          { id: "default", archived: false },
          { id: "old-friend", archived: true },
        ],
      }),
      stderr: "",
    }));
    const out = await driver.sourcesListJson();
    expect(out.sources?.map((s) => [s.id, s.archived])).toEqual([
      ["default", false],
      ["old-friend", true],
    ]);
  });

  test("doctorCycleFreshness returns the check envelope; non-JSON stdout is protocol drift", async () => {
    const { driver } = makeDriver(async () => ({
      stdout: JSON.stringify({
        status: "unhealthy",
        checks: [
          { name: "cycle_freshness", status: "fail", message: "Source 'yon-bip' last cycled 69h ago" },
        ],
      }),
      stderr: "",
    }));
    const out = await driver.doctorCycleFreshness();
    expect(out.checks?.[0]?.status).toBe("fail");

    const { driver: bad } = makeDriver(async () => ({ stdout: "not json", stderr: "" }));
    await expect(bad.doctorCycleFreshness()).rejects.toBeInstanceOf(CliExecutionError);
  });
});

describe("doctor exit-1 verdict recovery (0.60.558 probed behavior)", () => {
  function failingDoctor(stdout: string, code = 1) {
    return makeDriver(async () => {
      const err = new Error("exit 1") as Error & {
        code?: number | string;
        stderr?: string;
        stdout?: string;
      };
      err.code = code;
      err.stderr = "[gbrain] reading doctor checks; progress prints…";
      err.stdout = stdout;
      throw err;
    });
  }

  test("unhealthy verdict (exit 1 + full JSON envelope) is recovered, not an error", async () => {
    const { driver } = failingDoctor(
      JSON.stringify({
        status: "unhealthy",
        checks: [{ name: "cycle_freshness", status: "fail", message: "Source 'yon-bip' last cycled 69h ago" }],
      }),
    );
    const out = await driver.doctorCycleFreshness();
    expect(out.checks?.[0]?.status).toBe("fail");
    expect(out.checks?.[0]?.message).toContain("69h");
  });

  test("exit 1 with non-verdict stdout still throws (real failure)", async () => {
    const { driver } = failingDoctor("panic: something else");
    await expect(driver.doctorCycleFreshness()).rejects.toBeInstanceOf(CliExecutionError);
  });

  test("other nonzero exits never take the recovery path", async () => {
    const { driver } = failingDoctor('{"checks":[]}', 2);
    await expect(driver.doctorCycleFreshness()).rejects.toThrow(/exit 2/);
  });
});

// --- 0.5.0: doctor CHECK SETS + sources writer status ---------------------------

describe("doctor check sets (0.5.0)", () => {
  test("each set is one exact comma-joined --only value; order frozen", async () => {
    // The whitelist entry IS the set table in regex form — assert the argv
    // carries the exact joined string for every set (server assembly only,
    // no request data can reshape it).
    const cases: Array<[Parameters<CliDriver["doctorChecks"]>[0], string[]]> = [
      ["nightly", ["doctor", "--only", "cycle_freshness,sync_freshness,extract_health,dream_paid_loop,global_maintenance_stalled,default_source_local_path,chat_fallback_chain,cron_gbrain_home", "--json"]],
      ["calibration", ["doctor", "--only", "takes_count,takes_weight_grid", "--json"]],
      ["assets", ["doctor", "--only", "backup_coverage,git_convergence,unindexed_files,ghost_pages", "--json"]],
      ["topology", ["doctor", "--only", "cycle_phase_scope", "--json"]],
    ];
    for (const [set, expectedArgv] of cases) {
      const { driver, calls } = makeDriver(async () => ({
        stdout: JSON.stringify({ checks: [] }),
        stderr: "",
      }));
      await driver.doctorChecks(set);
      expect(calls[0]!.argv).toEqual(expectedArgv);
    }
  });

  test("no other --only value is accepted (set membership is the whitelist)", () => {
    for (const probe of [
      "cycle_freshness,sync_freshness,evil_check",
      "takes_count;rm -rf",
      "",
      "cycle_freshness sync_freshness",
      "doctor",
    ]) {
      expect(() =>
        buildArgv("doctor nightly", { check: probe }),
      ).toThrow(CliValidationError);
    }
  });

  test("not_applicable rows pass through raw (three-state normalization is shared's)", async () => {
    const { driver } = makeDriver(async () => ({
      stdout: JSON.stringify({
        status: "healthy",
        checks: [
          {
            name: "cron_gbrain_home",
            status: "ok",
            message: "No finding: this check does not apply to this brain right now.",
            severity: "info",
            readiness_state: "not_applicable",
            category: "ops",
          },
        ],
      }),
      stderr: "",
    }));
    const out = await driver.doctorChecks("nightly");
    expect(out.checks?.[0]?.readiness_state).toBe("not_applicable");
  });

  test("unhealthy set verdict (exit 1 + full envelope) is recovered like cycle_freshness", async () => {
    const { driver } = makeDriver(async () => {
      const err = new Error("exit 1") as Error & {
        code?: number | string;
        stderr?: string;
        stdout?: string;
      };
      err.code = 1;
      err.stderr = "banner";
      err.stdout = JSON.stringify({
        status: "unhealthy",
        checks: [{ name: "sync_freshness", status: "fail", message: "never synced" }],
      });
      throw err;
    });
    const out = await driver.doctorChecks("nightly");
    expect(out.checks?.[0]?.status).toBe("fail");
  });

  test("sources writer status builds its whitelisted argv and parses JSON", async () => {
    const { driver, calls } = makeDriver(async () => ({
      stdout: JSON.stringify({ bindings: [], worktrees: [] }),
      stderr: "",
    }));
    const out = await driver.sourcesWriterStatus();
    expect(calls[0]!.argv).toEqual([
      "sources",
      "writer",
      "status",
      "--json",
    ]);
    expect(out.bindings).toEqual([]);
  });
});

// --- 0.5.1: model wiring verbs ---------------------------------------------------
// Shapes pinned on 0.60.611 (internal/probes/model-wiring-0.60.611-20261112.md):
// providers explain / models read / doctor model set are flag-only reads;
// models doctor is the paid live probe (admin tier at the route). providers
// list/test are deliberately NOT whitelisted (human output / no --json).

describe("model wiring verbs: buildArgv shape (0.5.1)", () => {
  test("providers explain / models read / models doctor are flag-only --json", () => {
    expect(buildArgv("providers explain", {})).toEqual([
      "providers",
      "explain",
      "--json",
    ]);
    expect(buildArgv("models read", {})).toEqual(["models", "read", "--json"]);
    expect(buildArgv("models doctor", {})).toEqual(["models", "doctor", "--json"]);
  });

  test("doctor model set is the frozen comma string from the shared table", () => {
    expect(() =>
      buildArgv("doctor model", { check: "alternative_providers" }),
    ).toThrow(CliValidationError);
    expect(
      buildArgv("doctor model", {
        check:
          "alternative_providers,provider_consent,embedding_key_source,embedding_env_override,derivation_unpriced_model,reranker_health",
      }),
    ).toEqual([
      "doctor",
      "--only",
      "alternative_providers,provider_consent,embedding_key_source,embedding_env_override,derivation_unpriced_model,reranker_health",
      "--json",
    ]);
  });

  test("providers list and providers test are NOT whitelisted (human output)", () => {
    expect(() => buildArgv("providers list", {})).toThrow(CliValidationError);
    expect(() =>
      buildArgv("providers test", { model: "zhipu:glm-5.3" }),
    ).toThrow(CliValidationError);
  });
});

describe("model wiring verbs: CliDriver (0.5.1)", () => {
  test("providersExplain / modelsRead parse and pass scoped exec opts through", async () => {
    const { driver, calls } = makeDriver(async () => ({
      stdout: JSON.stringify({ env_detected: { ANTHROPIC_API_KEY: true }, options: [] }),
      stderr: "",
    }));
    const out = await driver.providersExplain({
      bin: "/real/gbrain",
      env: { GBRAIN_HOME: "/home/dev/gbrain-bip" },
    });
    expect(out.env_detected).toEqual({ ANTHROPIC_API_KEY: true });
    expect(calls[0]!.bin).toBe("/real/gbrain");
    expect(calls[0]!.env?.GBRAIN_HOME).toBe("/home/dev/gbrain-bip");

    const { driver: r } = makeDriver(async () => ({
      stdout: JSON.stringify({ tiers: [], per_task: [] }),
      stderr: "",
    }));
    const wiring = await r.modelsRead();
    expect(wiring.tiers).toEqual([]);
  });

  test("modelsDoctor parses the all-green envelope", async () => {
    const { driver, calls } = makeDriver(async () => ({
      stdout: JSON.stringify({
        schema_version: 1,
        probes: [
          { model: "zhipu:glm-5.3", touchpoint: "chat", status: "ok", message: "reachable", elapsed_ms: 1589 },
        ],
        summary: { total: 1, ok: 1, failed: 0 },
      }),
      stderr: "",
    }));
    const out = await driver.modelsDoctor();
    expect(calls[0]!.argv).toEqual(["models", "doctor", "--json"]);
    expect(out.summary).toEqual({ total: 1, ok: 1, failed: 0 });
  });

  test("failed probes (exit 1 + probes[] envelope) recover as DATA, not errors", async () => {
    const { driver } = makeDriver(async () => {
      const err = new Error("exit 1") as Error & {
        code?: number | string;
        stderr?: string;
        stdout?: string;
      };
      err.code = 1;
      err.stderr = "✗ transient error …";
      err.stdout = JSON.stringify({
        probes: [
          { model: "zhipu:glm-5.3", touchpoint: "chat", status: "fail", message: "余额不足" },
        ],
        summary: { total: 5, ok: 4, failed: 1 },
      });
      throw err;
    });
    const out = await driver.modelsDoctor();
    expect((out.probes as { status?: string }[])[0]?.status).toBe("fail");
    expect((out.summary as { failed?: number }).failed).toBe(1);
  });

  test("modelsDoctor exit 1 with non-verdict stdout still throws; exit 2 never recovers", async () => {
    const { driver: bad } = makeDriver(async () => {
      const err = new Error("exit 1") as Error & { code?: number; stdout?: string };
      err.code = 1;
      err.stdout = "panic: something else";
      throw err;
    });
    await expect(bad.modelsDoctor()).rejects.toBeInstanceOf(CliExecutionError);

    const { driver: two } = makeDriver(async () => {
      const err = new Error("exit 2") as Error & { code?: number; stdout?: string };
      err.code = 2;
      err.stdout = JSON.stringify({ probes: [] });
      throw err;
    });
    await expect(two.modelsDoctor()).rejects.toThrow(/exit 2/);
  });
});
