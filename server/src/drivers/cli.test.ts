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
    expect(buildArgv("takes propose list", { limit: "500" })).toEqual([
      "takes",
      "propose",
      "--limit",
      "500",
      "--json",
    ]);
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
    expect(() => buildArgv("takes propose list", { limit: "1;evil" })).toThrow(
      CliValidationError,
    );
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
    expect(() => buildArgv("takes propose list", {})).toThrow(
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
  handler: (bin: string, argv: string[]) => Promise<{ stdout: string; stderr: string }>,
) {
  const calls: { bin: string; argv: string[] }[] = [];
  const driver = new CliDriver("/fake/gbrain", {
    exec: async (bin, argv) => {
      calls.push({ bin, argv });
      return handler(bin, argv);
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

  test("takes propose list/accept/reject build whitelisted argv", async () => {
    const { driver, calls } = makeDriver(async (_bin, argv) => ({
      stdout: argv.includes("--json")
        ? JSON.stringify([{ id: 606, page_slug: "x", claim_text: "y" }])
        : "promoted",
      stderr: "",
    }));
    const items = await driver.takesProposeList(500);
    expect(items[0]?.id).toBe(606);
    expect(calls[0]?.argv).toEqual([
      "takes",
      "propose",
      "--limit",
      "500",
      "--json",
    ]);
    const accepted = await driver.takesProposeAccept("606");
    expect(accepted.output).toBe("promoted");
    expect(calls[1]?.argv).toEqual(["takes", "propose", "--accept", "606"]);
    expect((await driver.takesProposeReject("606")).output).toBe("promoted");
    expect(calls[2]?.argv).toEqual(["takes", "propose", "--reject", "606"]);
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
