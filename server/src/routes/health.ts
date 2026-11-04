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
import type { Config } from "../config";
import { inspectCli } from "../drivers/cli";
import { McpDriver, McpError } from "../drivers/mcp";
import type { PgReadonlyDriver } from "../drivers/pg-readonly";

// /healthz assembly (ARCHITECTURE §5-11). The MCP probe doubles as the
// startup canary: if gbrain is unreachable we say so instead of guessing.
// Results are cached briefly so uptime pollers (the brain host runs
// uptime-kuma) can't eat gbrain's 60 req/min token budget.

const CACHE_TTL_MS = 10_000;
const PROCESS_STARTED_AT = Date.now();

let cache: { at: number; report: HealthReport } | null = null;

export async function getHealthReport(
  cfg: Config,
  mcp: McpDriver,
  pg: PgReadonlyDriver | null = null,
  opts: { force?: boolean } = {},
): Promise<HealthReport> {
  if (!opts.force && cache && Date.now() - cache.at < CACHE_TTL_MS) {
    return cache.report;
  }

  const mcpCheck = await checkMcp(mcp);
  const brainCheck: BrainCheck =
    mcpCheck.status === "down"
      ? { status: "down", error: mcpCheck.error }
      : await checkBrain(mcp);
  const cliCheck: CliCheck = await inspectCli(cfg.gbrainBin);
  const pgCheck = await checkPg(pg);

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
    checks: { mcp: mcpCheck, brain: brainCheck, cli: cliCheck, ...(pgCheck ? { pg: pgCheck } : {}) },
  };
  cache = { at: Date.now(), report };
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

function mcpErrorToStatus(kind: McpError["kind"]): CheckStatus {
  // Rate limiting means gbrain is alive but throttling — degraded, not down.
  return kind === "rate-limit" || kind === "protocol" ? "degraded" : "down";
}

async function checkMcp(mcp: McpDriver): Promise<McpCheck> {
  const started = performance.now();
  try {
    const raw = (await mcp.whoami()) ?? {};
    // 0.60.558 names the caller `token_name`; normalize so the UI shows
    // whichever field the gbrain version provides.
    const tokenName =
      typeof raw.token_name === "string" ? raw.token_name : undefined;
    const whoami: McpWhoami = {
      ...raw,
      client: raw.client ?? tokenName,
    };
    return {
      status: "ok",
      latencyMs: Math.round(performance.now() - started),
      whoami,
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

/** read-only graph bypass probe — only present when the DSN is configured */
async function checkPg(pg: PgReadonlyDriver | null): Promise<PgCheck | null> {
  if (!pg || !pg.configured) return null;
  try {
    const latencyMs = await pg.ping();
    return { status: "ok", latencyMs };
  } catch (err) {
    return { status: "down", error: err instanceof Error ? err.message : String(err) };
  }
}
