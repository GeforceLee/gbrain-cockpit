import { execFile } from "node:child_process";
import { access, constants } from "node:fs/promises";
import { promisify } from "node:util";
import type {
  CliChannelStatus,
  EdgeProposal,
  TakeProposal,
  TrustReviewEnvelope,
} from "@gbrain-cockpit/shared";

// The narrow CLI channel (ARCHITECTURE §3.2): the only gbrain subcommands
// cockpit may exec, with dual-layer validation — the whitelist below is the
// first layer, and every argument additionally matches a regex before the
// process is ever spawned. execFile with array args only (no shell), `--`
// before positionals so a ref can never be parsed as a flag. Anything outside
// the whitelist throws CliValidationError → 400 at the route layer.

const execFileP = promisify(execFile);

export class CliValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliValidationError";
  }
}

export class CliExecutionError extends Error {
  constructor(
    message: string,
    readonly exitCode?: number,
    readonly timedOut = false,
  ) {
    super(message);
    this.name = "CliExecutionError";
  }
}

interface PositionalSpec {
  kind: "positional";
  /** for error messages and audit entries */
  name: string;
  regex: RegExp;
}

interface FlagSpec {
  kind: "flag";
  /** exact literal, e.g. "--json" */
  literal: string;
}

interface ValueFlagSpec {
  kind: "value";
  /** exact literal, e.g. "--accept" */
  literal: string;
  name: string;
  regex: RegExp;
}

type ArgSpec = PositionalSpec | FlagSpec | ValueFlagSpec;

interface SubcommandSpec {
  /** subcommand words, e.g. ["edge-proposals", "accept"] */
  words: readonly string[];
  args: readonly ArgSpec[];
  /** true when the command prints JSON on stdout */
  json: boolean;
}

const REF_RE = /^(tp|h|f|a|t)\d{1,18}$/;
const ID_RE = /^\d{1,18}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const LIMIT_RE = /^\d{1,4}$/;

// The live list — GBRAIN-CAPABILITIES.md §2 is the source of truth; keep both
// in sync when probes correct it.
const WHITELIST: Readonly<Record<string, SubcommandSpec>> = {
  "trust review": {
    words: ["trust", "review"],
    args: [{ kind: "flag", literal: "--json" }],
    json: true,
  },
  "trust drop": {
    words: ["trust", "drop"],
    args: [{ kind: "positional", name: "ref", regex: REF_RE }],
    json: false,
  },
  "edge-proposals list": {
    words: ["edge-proposals", "list"],
    args: [{ kind: "flag", literal: "--json" }],
    json: true,
  },
  "edge-proposals show": {
    words: ["edge-proposals", "show"],
    args: [
      { kind: "positional", name: "id", regex: ID_RE },
      { kind: "flag", literal: "--json" },
    ],
    json: true,
  },
  "edge-proposals accept": {
    words: ["edge-proposals", "accept"],
    args: [{ kind: "positional", name: "id", regex: ID_RE }],
    json: false,
  },
  "edge-proposals reject": {
    words: ["edge-proposals", "reject"],
    args: [{ kind: "positional", name: "id", regex: ID_RE }],
    json: false,
  },
  "edge-proposals date": {
    words: ["edge-proposals", "date"],
    args: [
      { kind: "positional", name: "id", regex: ID_RE },
      { kind: "positional", name: "date", regex: DATE_RE },
    ],
    json: false,
  },
  "edge-proposals undo": {
    words: ["edge-proposals", "undo"],
    args: [{ kind: "positional", name: "id", regex: ID_RE }],
    json: false,
  },
  // takes propose family (verified 2026-11-04 on 0.60.558): the pending
  // LLM-proposed takes queue — the REAL source of the Inbox takes queue.
  // Note the CLI shape: accept/reject are value flags on `takes propose`,
  // not subcommand positionals.
  "takes propose list": {
    words: ["takes", "propose"],
    args: [
      { kind: "value", literal: "--limit", name: "limit", regex: LIMIT_RE },
      { kind: "flag", literal: "--json" },
    ],
    json: true,
  },
  "takes propose accept": {
    words: ["takes", "propose"],
    args: [{ kind: "value", literal: "--accept", name: "id", regex: ID_RE }],
    json: false,
  },
  "takes propose reject": {
    words: ["takes", "propose"],
    args: [{ kind: "value", literal: "--reject", name: "id", regex: ID_RE }],
    json: false,
  },
};

export function getSpec(key: string): SubcommandSpec {
  const spec = WHITELIST[key];
  if (!spec) {
    throw new CliValidationError(`subcommand not whitelisted: ${key}`);
  }
  return spec;
}

/**
 * Validate named values against the spec and build the execFile argv.
 * Every value (flag value or positional) must pass its regex — anything
 * else throws before a process is ever spawned.
 */
export function buildArgv(
  key: string,
  values: Record<string, string>,
): string[] {
  const spec = getSpec(key);
  const argv = [...spec.words];
  const positionals: string[] = [];
  for (const arg of spec.args) {
    switch (arg.kind) {
      case "flag":
        argv.push(arg.literal);
        break;
      case "value": {
        const provided = values[arg.name];
        if (provided === undefined || !arg.regex.test(provided)) {
          throw new CliValidationError(
            `${key}: invalid ${arg.name} ${JSON.stringify(provided)}`,
          );
        }
        argv.push(arg.literal, provided);
        break;
      }
      case "positional": {
        const provided = values[arg.name];
        if (provided === undefined || !arg.regex.test(provided)) {
          throw new CliValidationError(
            `${key}: invalid ${arg.name} ${JSON.stringify(provided)}`,
          );
        }
        positionals.push(provided);
        break;
      }
    }
  }
  // `--` guard: positionals can never be interpreted as flags even if a
  // future gbrain starts parsing dash-prefixed refs.
  return positionals.length > 0 ? [...argv, "--", ...positionals] : argv;
}

const CONCURRENCY = 2;
const TIMEOUT_MS = 30_000; // cold-path budget; warm/cold smoke lands later
const MAX_BUFFER = 10 * 1024 * 1024;
const PROBE_TTL_MS = 60_000;

interface RawResult {
  stdout: string;
  stderr: string;
}

export interface CliDriverDeps {
  /** injectable for tests */
  exec?: (bin: string, argv: string[]) => Promise<RawResult>;
}

export class CliDriver {
  readonly #bin: string;
  readonly #exec: (bin: string, argv: string[]) => Promise<RawResult>;
  #inFlight = 0;
  #queue: Array<() => void> = [];
  #probe: { at: number; result: CliChannelStatus } | null = null;

  constructor(bin: string, deps: CliDriverDeps = {}) {
    this.#bin = bin;
    this.#exec =
      deps.exec ??
      (async (bin, argv) => {
        const { stdout, stderr } = await execFileP(bin, argv, {
          timeout: TIMEOUT_MS,
          maxBuffer: MAX_BUFFER,
          encoding: "utf8",
        });
        return { stdout, stderr };
      });
  }

  /**
   * Channel availability (cached briefly). Available means: the binary runs
   * AND `trust review --json` succeeds against THIS host's brain. A dev Mac
   * with its own unrelated gbrain install fails here; the same-host identity
   * check hardens with the warm/cold canary work (ARCHITECTURE §11-3).
   */
  async status(force = false): Promise<CliChannelStatus> {
    if (!force && this.#probe && Date.now() - this.#probe.at < PROBE_TTL_MS) {
      return this.#probe.result;
    }
    let result: CliChannelStatus;
    try {
      await this.trustReview();
      result = { available: true, probedAt: new Date().toISOString() };
    } catch (err) {
      result = {
        available: false,
        probedAt: new Date().toISOString(),
        error: err instanceof Error ? err.message : String(err),
      };
    }
    this.#probe = { at: Date.now(), result };
    return result;
  }

  async trustReview(): Promise<TrustReviewEnvelope> {
    return this.#runJson("trust review", {});
  }

  async trustDrop(ref: string): Promise<{ output: string }> {
    return this.#runText("trust drop", { ref });
  }

  async edgeList(): Promise<EdgeProposal[]> {
    return this.#runJson("edge-proposals list", {});
  }

  async edgeAccept(id: string): Promise<{ output: string }> {
    return this.#runText("edge-proposals accept", { id });
  }

  async edgeReject(id: string): Promise<{ output: string }> {
    return this.#runText("edge-proposals reject", { id });
  }

  async edgeDate(id: string, date: string): Promise<{ output: string }> {
    return this.#runText("edge-proposals date", { id, date });
  }

  async edgeUndo(id: string): Promise<{ output: string }> {
    return this.#runText("edge-proposals undo", { id });
  }

  /** Pending LLM-proposed takes queue (the Inbox takes queue's real source). */
  async takesProposeList(limit = 500): Promise<TakeProposal[]> {
    return this.#runJson("takes propose list", { limit: String(limit) });
  }

  async takesProposeAccept(id: string): Promise<{ output: string }> {
    return this.#runText("takes propose accept", { id });
  }

  async takesProposeReject(id: string): Promise<{ output: string }> {
    return this.#runText("takes propose reject", { id });
  }

  async #runJson<T>(key: string, values: Record<string, string>): Promise<T> {
    const { stdout } = await this.#runRaw(key, values);
    try {
      return JSON.parse(stdout) as T;
    } catch {
      throw new CliExecutionError(
        `${key}: stdout was not JSON (protocol drift? re-run probes)`,
      );
    }
  }

  async #runText(
    key: string,
    values: Record<string, string>,
  ): Promise<{ output: string }> {
    const { stdout } = await this.#runRaw(key, values);
    return { output: stdout.trim().slice(0, 2000) };
  }

  async #runRaw(
    key: string,
    values: Record<string, string>,
  ): Promise<RawResult> {
    // Layer 1 + layer 2 validation happens inside buildArgv: whitelist key,
    // per-argument regex, and the `--` separator. Nothing untrusted reaches
    // the child process.
    const argv = buildArgv(key, values);
    await this.#acquire();
    try {
      const started = performance.now();
      try {
        const result = await this.#exec(this.#bin, argv);
        const latencyMs = Math.round(performance.now() - started);
        if (latencyMs > 1000) {
          // Cold-start smell: cli-socket not warm or serve needs a restart
          // (ARCHITECTURE §3.2 silent-degradation trap).
          console.warn(
            `[cli] ${key} took ${latencyMs}ms (cold path? restart serve to restore warm)`,
          );
        }
        if (result.stderr.trim()) {
          // stderr never reaches the browser; full text stays in server logs.
          console.warn(`[cli] ${key} stderr: ${result.stderr.trim()}`);
        }
        return result;
      } catch (err) {
        const e = err as NodeJS.ErrnoException & {
          code?: string | number;
          killed?: boolean;
          signal?: string;
          stderr?: string;
        };
        if (e.code === "ENOENT") {
          throw new CliExecutionError(
            `gbrain binary not found at ${this.#bin}`,
          );
        }
        if (e.killed || e.signal === "SIGTERM") {
          throw new CliExecutionError(`${key}: timed out`, undefined, true);
        }
        // execFile rejects with stderr attached for nonzero exits.
        const stderrFirstLine = String(e.stderr ?? "")
          .split("\n")
          .find((l) => l.trim())?.slice(0, 200);
        throw new CliExecutionError(
          stderrFirstLine
            ? `${key} failed: ${stderrFirstLine}`
            : `${key} failed (exit ${e.code})`,
          typeof e.code === "number" ? e.code : undefined,
        );
      }
    } finally {
      this.#release();
    }
  }

  // concurrency gate: at most CONCURRENCY concurrent gbrain execs
  async #acquire(): Promise<void> {
    if (this.#inFlight < CONCURRENCY) {
      this.#inFlight++;
      return;
    }
    await new Promise<void>((resolve) => this.#queue.push(resolve));
    this.#inFlight++;
  }

  #release(): void {
    this.#inFlight--;
    this.#queue.shift()?.();
  }
}

export async function locateGbrainBin(
  explicit?: string | null,
): Promise<string | null> {
  if (explicit) {
    try {
      await access(explicit, constants.X_OK);
      return explicit;
    } catch {
      return null;
    }
  }
  try {
    const { stdout } = await execFileP("which", ["gbrain"]);
    const first = stdout.trim().split("\n")[0];
    return first ? first : null;
  } catch {
    return null;
  }
}

export async function inspectCli(gbrainBin: string | null): Promise<{
  status: "ok" | "degraded" | "down";
  bin: string | null;
  reason: "binary-found-unverified" | "binary-not-found";
  error?: string;
}> {
  const bin = await locateGbrainBin(gbrainBin);
  if (!bin) {
    return { status: "down", bin: null, reason: "binary-not-found" };
  }
  return { status: "degraded", bin, reason: "binary-found-unverified" };
}
