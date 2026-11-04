import { describe, expect, test } from "bun:test";
import {
  buildArgv,
  CliDriver,
  CliExecutionError,
  CliValidationError,
} from "./cli";

describe("buildArgv (whitelist discipline)", () => {
  test("flag-only subcommand", () => {
    expect(buildArgv("trust review", [])).toEqual(["trust", "review", "--json"]);
    expect(buildArgv("edge-proposals list", [])).toEqual([
      "edge-proposals",
      "list",
      "--json",
    ]);
  });

  test("positionals land after the -- separator", () => {
    expect(buildArgv("trust drop", [{ name: "ref", value: "tp42" }])).toEqual([
      "trust",
      "drop",
      "--",
      "tp42",
    ]);
    expect(
      buildArgv("edge-proposals date", [
        { name: "id", value: "7" },
        { name: "date", value: "2026-01-02" },
      ]),
    ).toEqual(["edge-proposals", "date", "--", "7", "2026-01-02"]);
  });

  test("flag injection through a positional is impossible", () => {
    expect(() =>
      buildArgv("trust drop", [{ name: "ref", value: "--json" }]),
    ).toThrow(CliValidationError);
    expect(() =>
      buildArgv("trust drop", [{ name: "ref", value: "-rf" }]),
    ).toThrow(CliValidationError);
    expect(() =>
      buildArgv("trust drop", [{ name: "ref", value: "tp1;rm -rf /" }]),
    ).toThrow(CliValidationError);
  });

  test("whitelist refs only, by prefix", () => {
    for (const good of ["tp1", "h123", "f1", "a99", "t42"]) {
      expect(() =>
        buildArgv("trust drop", [{ name: "ref", value: good }]),
      ).not.toThrow();
    }
    for (const bad of ["x1", "TP1", "tp", "tp" + "9".repeat(19), ""]) {
      expect(() =>
        buildArgv("trust drop", [{ name: "ref", value: bad }]),
      ).toThrow(CliValidationError);
    }
  });

  test("argument count must match the spec exactly", () => {
    expect(() => buildArgv("trust drop", [])).toThrow(CliValidationError);
    expect(() =>
      buildArgv("edge-proposals date", [{ name: "id", value: "7" }]),
    ).toThrow(CliValidationError);
  });

  test("unknown subcommands are rejected before any exec", () => {
    expect(() => buildArgv("trust confirm", [{ name: "ref", value: "tp1" }])).toThrow(
      CliValidationError,
    );
    expect(() => buildArgv("rm -rf", [])).toThrow(CliValidationError);
    expect(() =>
      buildArgv("edge-proposals retry", [{ name: "id", value: "1" }]),
    ).toThrow(CliValidationError);
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
