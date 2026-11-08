import { readFile } from "node:fs/promises";
import { OWNER_BIN_RE } from "@gbrain-cockpit/shared";
import type { TakeQueueCommands } from "@gbrain-cockpit/shared";

// Source-scoped takes adjudication guard (Inbox multi-source fix).
//
// gbrain 0.60.558's `takes propose` family resolves ONE source per run —
// resolveSourceId walks explicit flag → GBRAIN_SOURCE → dotfile → config →
// sole-non-default → literal 'default' — and threads it into list, accept
// and reject as an equality filter (`source_id = $n`, probed in
// src/core/take-proposals.ts). On a multi-source brain with no GBRAIN_SOURCE
// in play, every non-default-source proposal is invisible AND
// unadjudicatable ("No take proposal #n in source 'default'").
//
// The queue read therefore moved to the read-only bypass (cross-source by
// nature); accept/reject stay on the CLI — the only writer — but must exec
// the REAL gbrain binary with GBRAIN_SOURCE=<the row's source_id> and
// GBRAIN_HOME=<the profile's brain home>. Isolated-brain wrapper scripts
// (the cliBin of a multi-brain host) unset GBRAIN_SOURCE by design, so the
// direct call bypasses them — and this module replicates the wrapper's own
// safety assertion before every exec: <gbrainHome>/.gbrain/config.json's
// database_url must point at the database the profile's pgReadonlyDsn
// already names, else the exec is refused (a repointed brain config must
// never turn cockpit into a cross-brain writer).

/** upstream's own env-tier charset (src/core/source-resolver.ts tier 2) */
const GBRAIN_SOURCE_ENV_RE = /^[a-z0-9-]{1,32}$/;

/**
 * Absolute, metachar-free path for gbrainHome — it becomes env-prefix text
 * the owner pastes into a shell, so spaces/quotes/globs are rejected by
 * construction (same discipline as shared's OWNER_BIN_RE for the bin).
 */
const OWNER_HOME_RE = /^\/[A-Za-z0-9._/-]{1,200}$/;

/**
 * Copy-command templates for the takes queue's degraded rail (CLI channel
 * down). Built per source with a literal `{id}` placeholder — the id itself
 * never enters server-built shell text; the client substitutes it after its
 * own digits-only check, so even a hostile row id cannot become shell text.
 *
 * Shape rules (mirror the one-key path's guard exec exactly):
 * - direct-call pair configured → `GBRAIN_SOURCE=<src> GBRAIN_HOME=<home>
 *   <real-bin> takes propose --{accept|reject} {id}` for EVERY source,
 *   including `default` (deterministic, immune to the owner's shell env);
 * - no pair → the plain wrapper form, correct ONLY for rows in the default
 *   source (gbrain's resolver falls back to `default` without GBRAIN_SOURCE);
 * - anything else (non-default source, no pair) yields NO command — a pasted
 *   `not_found` failure is the exact bug this replaces, so the template set
 *   names the source `unavailable` and the UI explains instead.
 */
export function buildTakeQueueCommands(
  rows: Array<{ source_id?: string }>,
  opts: { cliBin: string; guard?: { bin: string; home: string } },
): TakeQueueCommands {
  const commands: TakeQueueCommands = { bySource: {}, unavailable: [] };
  const guard =
    opts.guard &&
    OWNER_BIN_RE.test(opts.guard.bin) &&
    OWNER_HOME_RE.test(opts.guard.home)
      ? opts.guard
      : undefined;
  const sources = new Set(rows.map((r) => r.source_id ?? "default"));
  for (const source of sources) {
    if (guard && GBRAIN_SOURCE_ENV_RE.test(source)) {
      const prefix = `GBRAIN_SOURCE=${source} GBRAIN_HOME=${guard.home} ${guard.bin}`;
      commands.bySource[source] = {
        accept: `${prefix} takes propose --accept {id}`,
        reject: `${prefix} takes propose --reject {id}`,
      };
      continue;
    }
    if (source === "default" && OWNER_BIN_RE.test(opts.cliBin)) {
      commands.bySource[source] = {
        accept: `${opts.cliBin} takes propose --accept {id}`,
        reject: `${opts.cliBin} takes propose --reject {id}`,
      };
      continue;
    }
    commands.unavailable.push(source);
  }
  return commands;
}

/**
 * The database name a postgres URL points at — the basename of its path.
 * "" when unparseable. Only ever the NAME: URLs carry credentials and must
 * never reach a log line or an error message.
 */
export function dbBasename(url: string): string {
  try {
    const u = new URL(url);
    if (u.protocol !== "postgres:" && u.protocol !== "postgresql:") return "";
    const segments = u.pathname.replace(/^\/+/, "").split("/");
    return segments[segments.length - 1] ?? "";
  } catch {
    return "";
  }
}

/**
 * The child env for one source-scoped exec: the server's environment minus
 * the two gbrain instance variables the wrappers also unset (GBRAIN_SOURCE,
 * GBRAIN_BRAIN_ID), plus the per-row scoping pair.
 */
export function buildScopedTakesEnv(
  processEnv: Record<string, string | undefined>,
  sourceId: string,
  gbrainHome: string,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(processEnv)) {
    if (value === undefined) continue;
    if (key === "GBRAIN_SOURCE" || key === "GBRAIN_BRAIN_ID") continue;
    env[key] = value;
  }
  env.GBRAIN_SOURCE = sourceId;
  env.GBRAIN_HOME = gbrainHome;
  return env;
}

/** Guard refusal — maps to 502 E_UPSTREAM at the route layer. */
export class TakesSourceGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TakesSourceGuardError";
  }
}

export interface TakesActionGuardDeps {
  /** injectable for tests */
  readFile?: (path: string) => Promise<string>;
}

export interface ScopedExec {
  bin: string;
  env: Record<string, string>;
}

/**
 * Per-profile guard for `takes propose --accept/--reject` on multi-source
 * brains. Constructed only when the profile declares gbrainBin + gbrainHome
 * (the opt-in); null context elsewhere keeps the legacy unscoped path.
 */
export class TakesActionGuard {
  readonly #bin: string;
  readonly #home: string;
  readonly #expectedDb: string;
  readonly #readFile: (path: string) => Promise<string>;

  constructor(
    opts: {
      gbrainBin: string;
      gbrainHome: string;
      /** database name the profile's pgReadonlyDsn points at */
      expectedDb: string;
    },
    deps: TakesActionGuardDeps = {},
  ) {
    this.#bin = opts.gbrainBin;
    this.#home = opts.gbrainHome;
    this.#expectedDb = opts.expectedDb;
    this.#readFile = deps.readFile ?? ((p) => readFile(p, "utf8"));
  }

  get bin(): string {
    return this.#bin;
  }

  /** The brain home this guard asserts against (copy-command templates need
   *  the same direct-call pair the one-key exec uses). */
  get home(): string {
    return this.#home;
  }

  /** Startup check — fail closed on a misconfigured pair before serving. */
  async assertStartup(): Promise<void> {
    await this.#assertDatabase();
  }

  /**
   * Validate the row's source_id and re-run the database assertion, then
   * hand back the direct-call bin + the scoped child env. The assertion
   * reruns per action on purpose: it is one small-file read, and a brain
   * config repointed after cockpit started must refuse here, not write to
   * the wrong brain.
   */
  async scopedExec(sourceId: string): Promise<ScopedExec> {
    if (!GBRAIN_SOURCE_ENV_RE.test(sourceId)) {
      throw new TakesSourceGuardError(
        `takes adjudication refused: proposal source_id ${JSON.stringify(sourceId)} fails gbrain's GBRAIN_SOURCE charset ([a-z0-9-]{1,32})`,
      );
    }
    await this.#assertDatabase();
    return {
      bin: this.#bin,
      env: buildScopedTakesEnv(process.env, sourceId, this.#home),
    };
  }

  async #assertDatabase(): Promise<void> {
    if (!this.#expectedDb) {
      throw new TakesSourceGuardError(
        "takes adjudication refused: no expected database name derivable from this profile's pgReadonlyDsn",
      );
    }
    const configPath = `${this.#home}/.gbrain/config.json`;
    let parsed: { database_url?: unknown };
    try {
      parsed = JSON.parse(await this.#readFile(configPath)) as {
        database_url?: unknown;
      };
    } catch {
      // unreadable or not JSON — name the path, never the contents
      throw new TakesSourceGuardError(
        `takes adjudication refused: cannot read the brain config at ${configPath} (direct-call safety assertion, mirrors the isolated-brain wrappers)`,
      );
    }
    const url = typeof parsed.database_url === "string" ? parsed.database_url : "";
    const actual = dbBasename(url);
    if (actual !== this.#expectedDb) {
      // basenames only — database_url carries credentials
      throw new TakesSourceGuardError(
        `takes adjudication refused: ${configPath} points at database "${actual || "?"}" but this profile's read-only DSN names "${this.#expectedDb}" — refusing to exec gbrain against the wrong brain`,
      );
    }
  }
}
