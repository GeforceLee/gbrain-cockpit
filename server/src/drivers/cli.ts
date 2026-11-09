import { execFile } from "node:child_process";
import { access, constants } from "node:fs/promises";
import { promisify } from "node:util";
import {
  FEDERATED_LIST_RE,
  OWNER_CLIENT_ID_RE,
  TRUST_REF_RE,
  validateFederatedReadList,
  type CliChannelStatus,
  type ContradictionProposal,
  type EdgeProposal,
  type OpsClientGrant,
  type TrustReviewEnvelope,
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

// Trust refs use the ONE shared pattern (shared/src TRUST_REF_RE) — the same
// constant the route layer and the web's copy-command builder use, so the
// three can never drift apart.
const REF_RE = TRUST_REF_RE;
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
  // takes propose adjudication verbs (verified 2026-11-04 on 0.60.558).
  // Note the CLI shape: accept/reject are value flags on `takes propose`,
  // not subcommand positionals. The LIST form is deliberately NOT
  // whitelisted anymore: gbrain scopes `takes propose` to ONE source per
  // run (resolveSourceId → 'default' with no GBRAIN_SOURCE), so a CLI list
  // on a multi-source brain silently hides every non-default source — the
  // queue reads the read-only bypass instead (pg-readonly.ts), and these
  // two verbs exec with GBRAIN_SOURCE=<the row's source_id> via the
  // TakesActionGuard's direct-call path when the profile opts in.
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
  // read-only companion view: pages whose extraction keeps failing and got
  // held. The release verb (--retry-failed) is deliberately NOT here —
  // surfacing held pages is cockpit's job, releasing them is the owner's.
  "takes propose failed": {
    words: ["takes", "propose"],
    args: [
      { kind: "flag", literal: "--failed" },
      { kind: "flag", literal: "--json" },
    ],
    json: true,
  },
  // Contradiction proposals — gbrain's dedicated decide family (probed on
  // 0.60.611, leewin: `decide proposals list --json` answers
  // {status, proposals, review_proposals}; pending is the default status).
  // No typed-token gate upstream — same adjudication class as edge-proposals.
  "decide proposals list": {
    words: ["decide", "proposals", "list"],
    args: [{ kind: "flag", literal: "--json" }],
    json: true,
  },
  "decide proposals accept": {
    words: ["decide", "proposals", "accept"],
    args: [{ kind: "positional", name: "id", regex: ID_RE }],
    json: false,
  },
  "decide proposals reject": {
    words: ["decide", "proposals", "reject"],
    args: [{ kind: "positional", name: "id", regex: ID_RE }],
    json: false,
  },
  "decide proposals undo": {
    words: ["decide", "proposals", "undo"],
    args: [{ kind: "positional", name: "id", regex: ID_RE }],
    json: false,
  },
  // --- management verbs (0.4.0, MANAGEMENT_CHANNELS; probes 2026-11-09 on
  // 0.60.558 — internal/probes/ops-management-0.60.558-20261109.md). The
  // structural shape is the security story: `auth rescope` accepts ONLY
  // --client + --federated-read here — upstream's real verb also reshapes
  // legacy tokens (--token/--takes-holders), and those forms must never be
  // reachable through cockpit. Values arrive server-derived (zero request
  // data reaches argv), the regexes below still gate every byte.
  "auth clients": {
    words: ["auth", "clients"],
    args: [{ kind: "flag", literal: "--json" }],
    json: true,
  },
  "auth rescope": {
    words: ["auth", "rescope"],
    args: [
      { kind: "value", literal: "--client", name: "clientId", regex: OWNER_CLIENT_ID_RE },
      {
        kind: "value",
        literal: "--federated-read",
        name: "sources",
        regex: FEDERATED_LIST_RE,
      },
    ],
    json: false,
  },
  // owner-view source registry incl. the `archived` flag — the active-source
  // gate for grant-read (upstream rescope does NOT check federated ids for
  // activeness; granting an archived one would brick token issuance).
  "sources list": {
    words: ["sources", "list"],
    args: [{ kind: "flag", literal: "--json" }],
    json: true,
  },
  // one check, by name: cycle_freshness reads sources.config→
  // last_full_cycle_at (upstream's own "pipeline ran" verdict). --only is
  // locked to this single check id — arbitrary doctor checks are NOT
  // whitelisted (several are slow/heavy; probed 1.26s for this one).
  "doctor cycle freshness": {
    words: ["doctor"],
    args: [
      { kind: "value", literal: "--only", name: "check", regex: /^cycle_freshness$/ },
      { kind: "flag", literal: "--json" }],
    json: true,
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
  /** injectable for tests; env is undefined for inherited-process-env execs */
  exec?: (
    bin: string,
    argv: string[],
    env?: Record<string, string>,
  ) => Promise<RawResult>;
}

/** Per-call overrides for source-scoped execs (takes adjudication). */
export interface ScopedExecOpts {
  /** the real gbrain binary, bypassing an isolated-brain wrapper cliBin */
  bin?: string;
  /** a fully-built child env (GBRAIN_SOURCE/GBRAIN_HOME set, GBRAIN_BRAIN_ID stripped) */
  env?: Record<string, string>;
}

export class CliDriver {
  readonly #bin: string;
  readonly #exec: (
    bin: string,
    argv: string[],
    env?: Record<string, string>,
  ) => Promise<RawResult>;
  #inFlight = 0;
  #queue: Array<() => void> = [];
  #probe: { at: number; result: CliChannelStatus } | null = null;

  constructor(bin: string, deps: CliDriverDeps = {}) {
    this.#bin = bin;
    this.#exec =
      deps.exec ??
      (async (bin, argv, env) => {
        const { stdout, stderr } = await execFileP(bin, argv, {
          timeout: TIMEOUT_MS,
          maxBuffer: MAX_BUFFER,
          encoding: "utf8",
          ...(env ? { env } : {}),
        });
        return { stdout, stderr };
      });
  }

  /**
   * Channel availability, stale-while-revalidate. Available means: the binary
   * runs AND `trust review --json` succeeds against THIS host's brain. A dev
   * Mac with its own unrelated gbrain install fails here. The probe is a real
   * CLI exec — on hosts without a warm cli-socket that is a multi-second cold
   * run, so a cached-but-stale answer returns immediately and the refresh
   * happens in the background; `force` awaits a fresh probe.
   */
  async status(force = false): Promise<CliChannelStatus> {
    if (!force && this.#probe) {
      if (Date.now() - this.#probe.at < PROBE_TTL_MS) {
        return this.#probe.result;
      }
      void this.#refresh().catch(() => {
        // background refresh failure keeps the stale entry; logged inside
      });
      return this.#probe.result;
    }
    return this.#refresh();
  }

  async #refresh(): Promise<CliChannelStatus> {
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

  /**
   * Pending contradiction proposals. The envelope carries both `proposals`
   * and `review_proposals`; the queue renders `proposals` (the pending lane —
   * review_proposals belongs to the sweep's own review flow, not the Inbox).
   */
  async decideProposalsList(): Promise<{
    proposals?: ContradictionProposal[];
    [k: string]: unknown;
  }> {
    return this.#runJson("decide proposals list", {});
  }

  async decideProposalsAccept(id: string): Promise<{ output: string }> {
    return this.#runText("decide proposals accept", { id });
  }

  async decideProposalsReject(id: string): Promise<{ output: string }> {
    return this.#runText("decide proposals reject", { id });
  }

  async decideProposalsUndo(id: string): Promise<{ output: string }> {
    return this.#runText("decide proposals undo", { id });
  }

  /**
   * Adjudicate a pending take proposal. `opts` carries the source-scoped
   * direct call (real binary + GBRAIN_SOURCE/GBRAIN_HOME env) built by
   * TakesActionGuard for multi-source brains; without it the exec runs
   * through the profile's cliBin with the inherited environment — the
   * legacy single-source path, preserved verbatim.
   */
  async takesProposeAccept(
    id: string,
    opts: ScopedExecOpts = {},
  ): Promise<{ output: string }> {
    return this.#runText("takes propose accept", { id }, opts);
  }

  async takesProposeReject(
    id: string,
    opts: ScopedExecOpts = {},
  ): Promise<{ output: string }> {
    return this.#runText("takes propose reject", { id }, opts);
  }

  /** Held-for-repeated-extraction-failure pages (read-only companion view). */
  async takesFailedList(): Promise<unknown> {
    return this.#runJson("takes propose failed", {});
  }

  // --- management verbs (0.4.0, MANAGEMENT_CHANNELS) ---------------------------

  /** Owner-view OAuth client registry (`auth clients --json`, own row included). */
  async authClients(
    opts: ScopedExecOpts = {},
  ): Promise<{ clients?: OpsClientGrant[]; [k: string]: unknown }> {
    return this.#runJson("auth clients", {}, opts);
  }

  /**
   * Widen a client's federated read scope. REPLACE semantics upstream:
   * `sources` must be the client's whole NEW list (current ∪ additions —
   * the route computes it server-side), list-validated on top of the
   * whitelist regexes.
   */
  async authRescope(
    clientId: string,
    sources: string[],
    opts: ScopedExecOpts = {},
  ): Promise<{ output: string }> {
    const list = validateFederatedReadList(sources).join(",");
    return this.#runText("auth rescope", { clientId, sources: list }, opts);
  }

  /** Owner-view source registry incl. the `archived` flag (active-source gate). */
  async sourcesListJson(
    opts: ScopedExecOpts = {},
  ): Promise<{
    sources?: { id: string; archived?: boolean; [k: string]: unknown }[];
    [k: string]: unknown;
  }> {
    return this.#runJson("sources list", {}, opts);
  }

  /**
   * The cycle_freshness doctor check — upstream's own "did the content
   * pipeline run" verdict (sources.config→last_full_cycle_at, warn 6h/fail
   * 24h). Structured consumption is name/status ONLY; `message` is human
   * prose the UI echoes verbatim, never parsed.
   */
  async doctorCycleFreshness(
    opts: ScopedExecOpts = {},
  ): Promise<{
    checks?: {
      name?: string;
      status?: string;
      message?: string;
      [k: string]: unknown;
    }[];
    [k: string]: unknown;
  }> {
    return this.#runJson("doctor cycle freshness", { check: "cycle_freshness" }, opts);
  }

  async #runJson<T>(
    key: string,
    values: Record<string, string>,
    opts?: ScopedExecOpts,
  ): Promise<T> {
    const { stdout } = await this.#runRaw(key, values, opts);
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
    opts?: ScopedExecOpts,
  ): Promise<{ output: string }> {
    const { stdout } = await this.#runRaw(key, values, opts);
    return { output: stdout.trim().slice(0, 2000) };
  }

  async #runRaw(
    key: string,
    values: Record<string, string>,
    opts?: ScopedExecOpts,
  ): Promise<RawResult> {
    // Layer 1 + layer 2 validation happens inside buildArgv: whitelist key,
    // per-argument regex, and the `--` separator. Nothing untrusted reaches
    // the child process — the optional env override is server-built only
    // (TakesActionGuard), never request-shaped.
    const argv = buildArgv(key, values);
    await this.#acquire();
    try {
      const started = performance.now();
      try {
        const result = await this.#exec(opts?.bin ?? this.#bin, argv, opts?.env);
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
        // execFile rejects with stderr attached for nonzero exits. Wrapper
        // scripts banner to stderr on EVERY run (e.g. "[gbrain-bip] → …");
        // those lines are noise here, not the failure — skip them so the
        // operator sees gbrain's own error instead of the banner.
        const stderrFirstLine = String(e.stderr ?? "")
          .split("\n")
          .find((l) => l.trim() && !WRAPPER_BANNER_RE.test(l))?.slice(0, 200);
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

/**
 * Banner lines wrapper scripts print to stderr on every invocation, e.g.
 * `[gbrain-bip] → postgres://…/bip`. Bracketed tag prefix, nothing else —
 * gbrain's own errors never start with a bracketed tag.
 */
const WRAPPER_BANNER_RE = /^\[[a-z0-9][a-z0-9 _-]*\]/i;

async function defaultWhich(name: string): Promise<string | null> {
  try {
    const { stdout } = await execFileP("which", [name]);
    const first = stdout.trim().split("\n")[0];
    return first ? first : null;
  } catch {
    return null;
  }
}

async function defaultAccessX(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export interface LocateDeps {
  /** injectable for tests: resolve a command NAME to an absolute path */
  which?: (name: string) => Promise<string | null>;
  /** injectable for tests: absolute-path executability check */
  accessX?: (path: string) => Promise<boolean>;
}

/**
 * Resolve the CLI executable for one brain. `explicit` is the profile's
 * cliBin — either an absolute path (checked for X_OK) or a bare command
 * name (resolved via PATH, so isolated-brain wrappers like `gbrain-bip`
 * work). Unset means the conventional `gbrain` on PATH. The charset of
 * `explicit` is OWNER_BIN_RE-validated at the config layer already.
 */
export async function locateGbrainBin(
  explicit?: string | null,
  deps: LocateDeps = {},
): Promise<string | null> {
  const which = deps.which ?? defaultWhich;
  const accessX = deps.accessX ?? defaultAccessX;
  if (explicit) {
    if (explicit.includes("/")) {
      return (await accessX(explicit)) ? explicit : null;
    }
    return which(explicit);
  }
  return which("gbrain");
}
