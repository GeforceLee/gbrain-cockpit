import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { EMPTY_REGISTRY_TEXT } from "./tokens";

// ONE server per registry — proven with real processes. Two starters race
// for the same registry (once on a clean slate, once over a stale lock left
// by a dead process); in every round at most one may win. The implementation
// review reproduced a double-hold in 84/180 and 29/180 rounds before the
// lock gained its creation grace period, takeover guard and read-back.

const REPO = join(import.meta.dir, "..", "..");

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const CHILD = `
import { TokenRegistry } from ${JSON.stringify(join(REPO, "server", "src", "tokens.ts"))};
import { existsSync, writeFileSync } from "node:fs";
import { ConfigError } from ${JSON.stringify(join(REPO, "server", "src", "config.ts"))};
const [file, out, goFile] = process.argv.slice(2);
const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
if (!goFile) throw new Error("usage: child <registry> <outDir> <goFile>");
writeFileSync(out + "/ready." + process.pid, "");
// a busy wait, not a poll: a 2 ms sleep let the two starters drift apart
// and the old double-hold slipped through a quarter of the rounds
for (let i = 0; i < 200000 && !existsSync(goFile); i++) void i;
let result = "refused";
try {
  const reg = TokenRegistry.load(file!, { knownBrains: () => new Set(["bip"]) });
  result = "ok";
  sleep(250); // hold it long enough to overlap the other starter
  reg.dispose();
} catch (err) {
  result = err instanceof ConfigError ? "refused" : "error: " + (err as Error).message;
}
writeFileSync(out + "/result." + process.pid, result);
`;

async function race(dir: string, file: string, round: number): Promise<string[]> {
  const script = join(dir, `child-${round}.ts`);
  writeFileSync(script, CHILD);
  const out = join(dir, `out-${round}`);
  mkdirSync(out);
  const go = join(dir, `go-${round}`);
  const procs = [0, 1].map(() =>
    Bun.spawn(["bun", "run", script, file, out, go], { stdout: "ignore", stderr: "pipe" }),
  );
  // both are parked on the start line before it drops
  for (let i = 0; i < 2500; i++) {
    const ready = readdirSync(out).filter((f) => f.startsWith("ready.")).length;
    if (ready === 2) break;
    await Bun.sleep(4);
  }
  writeFileSync(go, "");
  for (const p of procs) await p.exited;
  return readdirSync(out)
    .filter((f) => f.startsWith("result."))
    .map((f) => readFileSync(join(out, f), "utf8"))
    .sort();
}

describe("one server per registry — two starters race (real processes)", () => {
  test("at most one starter wins, on a clean slate and over a stale lock alike", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cockpit-tokens-race-"));
    dirs.push(dir);
    const file = join(dir, "tokens.json");
    let cleanWins = 0;
    for (let round = 0; round < 12; round++) {
      writeFileSync(file, EMPTY_REGISTRY_TEXT, { mode: 0o600 });
      chmodSync(file, 0o600);
      rmSync(`${file}.lock`, { force: true });
      rmSync(`${file}.lock.takeover`, { force: true });
      let stale = false;
      if (round % 2 === 1) {
        // a lock left behind by a process that is gone
        const dead = 4_100_000 + round;
        let alive = true;
        try {
          process.kill(dead, 0);
        } catch {
          alive = false;
        }
        stale = !alive;
        if (stale) writeFileSync(`${file}.lock`, `${dead} gone`, { mode: 0o600 });
      }
      const results = await race(dir, file, round);
      const wins = results.filter((r) => r === "ok").length;
      expect(results.filter((r) => r.startsWith("error:"))).toEqual([]);
      expect(wins).toBeLessThanOrEqual(1);
      if (!stale) {
        // a clean slate always ends with exactly one holder
        expect(wins).toBe(1);
        cleanWins++;
      }
    }
    expect(cleanWins).toBe(6);
    // and no starter leaves its guard behind
    expect(existsSync(`${file}.lock.takeover`)).toBe(false);
  }, 60_000);
});
