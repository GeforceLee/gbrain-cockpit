import { execFile } from "node:child_process";
import { access, constants } from "node:fs/promises";
import { promisify } from "node:util";
import type {
  CliChannelStatus,
  EdgeProposal,
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

type ArgSpec = PositionalSpec | FlagSpec;

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
};

export function getSpec(key: string): SubcommandSpec {
  const spec = WHITELIST[key];
  if (!spec) {
    throw new CliValidationError(`subcommand not whitelisted: ${key}`);
  }
  return spec;
}

/** Validate positionals against the spec and build the execFile argv. */
export function buildArgv(
  key: string,
  positionals: Array<{ name: string; value: string }>,
): string[] {
  const spec = getSpec(key);
  const expected = spec.args.filter(
    (a): a is PositionalSpec => a.kind === "positional",
  );
  if (positionals.length !== expected.length) {
    throw new CliValidationError(
      `${key}: expected ${expected.length} positional(s), got ${positionals.length}`,
    );
  }
  const argv = [...spec.words];
  for (const arg of spec.args) {
    if (arg.kind === "flag") {
      argv.push(arg.literal);
    }
  }
  // `--` guard: positionals can never be interpreted as flags even if a
  // future gbrain starts parsing dash-prefixed refs.
  const values: string[] = [];
  expected.forEach((specArg, i) => {
    const provided = positionals[i]!;
    if (provided.name !== specArg.name || !specArg.regex.test(provided.value)) {
      throw new CliValidationError(
        `${key}: invalid ${specArg.name} ${JSON.stringify(provided.value)}`,
      );
    }
    values.push(provided.value);
  });
  return values.length > 0 ? [...argv, "--", ...values] : argv;
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
    return this.#runJson("trust review", []);
  }

  async trustDrop(ref: string): Promise<{ output: string }> {
    return this.#runText("trust drop", [{ name: "ref", value: ref }]);
  }

  async edgeList(): Promise<EdgeProposal[]> {
    return this.#runJson("edge-proposals list", []);
  }

  async edgeAccept(id: string): Promise<{ output: string }> {
    return this.#runText("edge-proposals accept", [{ name: "id", value: id }]);
  }

  async edgeReject(id: string): Promise<{ output: string }> {
    return this.#runText("edge-proposals reject", [{ name: "id", value: id }]);
  }

  async edgeDate(
    id: string,
    date: string,
  ): Promise<{ output: string }> {
    return this.#runText("edge-proposals date", [
      { name: "id", value: id },
      { name: "date", value: date },
    ]);
  }

  async edgeUndo(id: string): Promise<{ output: string }> {
    return this.#runText("edge-proposals undo", [{ name: "id", value: id }]);
  }

  async #runJson<T>(key: string, positionals: Array<{ name: string; value: string }>): Promise<T> {
    const { stdout } = await this.#runRaw(key, positionals);
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
    positionals: Array<{ name: string; value: string }>,
  ): Promise<{ output: string }> {
    const { stdout } = await this.#runRaw(key, positionals);
    return { output: stdout.trim().slice(0, 2000) };
  }

  async #runRaw(
    key: string,
    positionals: Array<{ name: string; value: string }>,
  ): Promise<RawResult> {
    // Layer 1 + layer 2 validation happens inside buildArgv: whitelist key,
    // per-argument regex, and the `--` separator. Nothing untrusted reaches
    // the child process.
    const argv = buildArgv(key, positionals);
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
