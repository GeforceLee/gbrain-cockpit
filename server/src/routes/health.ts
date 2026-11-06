import {
  COCKPIT_VERSION,
  worstStatus,
  type BrainCheck,
  type CheckStatus,
  type CliCheck,
  type HealthReport,
  type McpCheck,
  type McpWhoami,
  type PgCheck,
} from "@gbrain-cockpit/shared";
import type { BrainChannels } from "../brains";
import type { CliDriver } from "../drivers/cli";
import { McpError, type McpDriver } from "../drivers/mcp";
import type { PgReadonlyDriver } from "../drivers/pg-readonly";

// /healthz assembly (ARCHITECTURE §5-11). The MCP probe doubles as the
// startup canary: if gbrain is unreachable we say so instead of guessing.
// Reports are cached PER PROFILE (a module-level single cache used to hand
// one brain's whoami to the other — the exact bleed multi-profile exists to
// prevent), and cached briefly so uptime pollers (the brain host runs
// uptime-kuma) can't eat gbrain's 60 req/min token budget.

const CACHE_TTL_MS = 10_000;
const PROCESS_STARTED_AT = Date.now();

const reports = new Map<string, { at: number; report: HealthReport }>();

export async function getHealthReport(
  ch: BrainChannels,
  opts: { force?: boolean } = {},
): Promise<HealthReport> {
  const cached = reports.get(ch.id);
  if (!opts.force && cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.report;
  }

  const mcpCheck = await checkMcp(ch.mcp);
  const brainCheck: BrainCheck =
    mcpCheck.status === "down"
      ? { status: "down", error: mcpCheck.error }
      : await checkBrain(ch.mcp);
  const cliCheck = await checkCli(ch.cliBinResolved, ch.cli, ch.cliNote);
  const pgCheck = await checkPg(ch.pg);

  const report: HealthReport = {
    status: worstStatus(
      mcpCheck.status,
      brainCheck.status,
      cliCheck.status,
      ...(pgCheck ? [pgCheck.status] : []),
    ),
    cockpitVersion: COCKPIT_VERSION,
    uptimeMs: Date.now() - PROCESS_STARTED_AT,
    generatedAt: new Date().toISOString(),
    profile: { id: ch.id, name: ch.profile.name },
    checks: {
      mcp: mcpCheck,
      brain: brainCheck,
      cli: cliCheck,
      ...(pgCheck ? { pg: pgCheck } : {}),
    },
  };
  reports.set(ch.id, { at: Date.now(), report });
  return report;
}

/** Unauthenticated view for /healthz: statuses only, no identity details. */
export function toCoarse(report: HealthReport): {
  status: CheckStatus;
  cockpitVersion: string;
  generatedAt: string;
  checks: Record<string, CheckStatus>;
} {
  return {
    status: report.status,
    cockpitVersion: report.cockpitVersion,
    generatedAt: report.generatedAt,
    checks: {
      mcp: report.checks.mcp.status,
      brain: report.checks.brain.status,
      cli: report.checks.cli.status,
      ...(report.checks.pg ? { pg: report.checks.pg.status } : {}),
    },
  };
}

/**
 * Normalize whoami across gbrain 0.60.558's per-transport shapes: legacy
 * bearers name the caller `token_name`; OAuth grants return `client_name`
 * (falling back to `client_id`) and never `client` or `token_name`. Scopes
 * arrive top-level in both (OAuth spreads its capabilities in).
 */
export function normalizeWhoami(raw: McpWhoami): McpWhoami {
  const client =
    (typeof raw.client === "string" && raw.client) ||
    (typeof raw.client_name === "string" && raw.client_name) ||
    (typeof raw.client_id === "string" && raw.client_id) ||
    (typeof raw.token_name === "string" && raw.token_name) ||
    undefined;
  return { ...raw, ...(client ? { client } : {}) };
}

function mcpErrorToStatus(kind: McpError["kind"]): CheckStatus {
  // Rate limiting means gbrain is alive but throttling — degraded, not down.
  return kind === "rate-limit" || kind === "protocol" ? "degraded" : "down";
}

async function checkMcp(mcp: McpDriver): Promise<McpCheck> {
  const started = performance.now();
  try {
    const raw = (await mcp.whoami()) ?? {};
    return {
      status: "ok",
      latencyMs: Math.round(performance.now() - started),
      whoami: normalizeWhoami(raw),
    };
  } catch (err) {
    if (err instanceof McpError) {
      return { status: mcpErrorToStatus(err.kind), error: err.message };
    }
    return { status: "down", error: (err as Error).message };
  }
}

async function checkBrain(mcp: McpDriver): Promise<BrainCheck> {
  try {
    const raw = (await mcp.brainIdentity()) ?? {};
    // 0.60.558 reports flat counters (page_count, chunk_count, …); group
    // the numeric ones for the UI's counts block.
    const counts: Record<string, number> = {};
    for (const [key, value] of Object.entries(raw)) {
      if (/^[a-z_]+_count$/.test(key) && typeof value === "number") {
        counts[key] = value;
      }
    }
    const identity: BrainCheck["identity"] =
      Object.keys(counts).length > 0 ? { ...raw, counts } : { ...raw };
    return { status: "ok", identity };
  } catch (err) {
    return {
      status: "degraded",
      error: err instanceof McpError ? err.message : (err as Error).message,
    };
  }
}

/**
 * CLI channel check for one profile. The registry resolved the bin at
 * startup (absolute path or PATH hit — a bare `which` fallback here would
 * find the WRONG brain's gbrain on a dual-brain host); with a live driver,
 * availability is decided by the real probe (`trust review --json`
 * succeeding against THIS host's brain) — the same truth the Inbox chip
 * shows. The probe result is stale-while-revalidate cached inside the
 * driver, so only the first health call per TTL window pays a cold run.
 */
/**
 * Single source of truth for "why is the CLI channel (un)available" —
 * the Inbox chip (via /api/inbox) and this health check read the same
 * probe, so they must derive the same reason or they'd tell two
 * different stories about one exec.
 */
export function cliReason(
  cli: CliDriver | null,
  probeAvailable: boolean,
): CliCheck["reason"] {
  if (!cli) return "binary-not-found";
  return probeAvailable ? "binary-verified" : "binary-found-unverified";
}

async function checkCli(
  resolvedBin: string | null,
  cli: CliDriver | null,
  note?: string,
): Promise<CliCheck> {
  if (!resolvedBin) {
    return {
      status: "down",
      bin: null,
      reason: "binary-not-found",
      ...(note ? { error: note } : {}),
    };
  }
  if (!cli) {
    return {
      status: "down",
      bin: resolvedBin,
      reason: "binary-not-found",
      ...(note ? { error: note } : {}),
    };
  }
  const probe = await cli.status();
  const reason = cliReason(cli, probe.available);
  if (probe.available) {
    return { status: "ok", bin: resolvedBin, reason };
  }
  return {
    status: "degraded",
    bin: resolvedBin,
    reason,
    ...(probe.error ? { error: probe.error } : {}),
  };
}

/** read-only graph bypass probe — only present when the DSN is configured */
async function checkPg(pg: PgReadonlyDriver | null): Promise<PgCheck | null> {
  if (!pg || !pg.configured) return null;
  try {
    const latencyMs = await pg.ping();
    return { status: "ok", latencyMs };
  } catch (err) {
    return {
      status: "down",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
