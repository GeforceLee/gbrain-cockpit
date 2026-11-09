import { randomUUID } from "node:crypto";
import type {
  AnomaliesReport,
  AuditHistoryReport,
  BrainHealthReport,
  CliChannelStatus,
  ContradictionsReport,
  ContradictionProposal,
  DecidedTakeRow,
  EdgeProposal,
  EvidenceReport,
  ExtractionQueue,
  ExtractionStub,
  GraphReport,
  InboxReport,
  InboxQueue,
  LinkRow,
  OpsClientGrant,
  OpsDreamRun,
  OpsDreamRunsReport,
  OpsGrantReadResult,
  OpsSourceDriftReport,
  OpsSourcePages,
  PageDetail,
  PageSummary,
  PageVersion,
  PagesFacets,
  ProfilesResponse,
  SearchHit,
  SourceDiagnostic,
  SourcesReport,
  SourcesStatusReport,
  TakeItem,
  TakeProposal,
  TakesQueue,
  TimelineEntry,
  TrustReviewEnvelope,
  TrustReviewItem,
  WriteConflictsReport,
  WriteReceipt,
  WriteRequestsReport,
} from "@gbrain-cockpit/shared";
import {
  authRescopeCommand,
  isValidSourceId,
  TRUST_REF_RE,
} from "@gbrain-cockpit/shared";
import { auditTail, auditWrite } from "../audit";
import type { BrainRegistry, BrainChannels } from "../brains";
import type { Principal } from "../auth";
import { BadRequestError, envelope, readJsonBody } from "../http";
import { CliExecutionError, CliValidationError } from "../drivers/cli";
import type { ScopedExecOpts } from "../drivers/cli";
import { McpError } from "../drivers/mcp";
import { TakesSourceGuardError, buildTakeQueueCommands } from "../drivers/takes-source";
import { cliReason } from "./health";

// API surface (core-loop milestone). Every handler receives an already
// authenticated request routed to ONE brain's channels (the x-brain-profile
// header picked the profile in index.ts); param validation is
// regex-whitelisted before it reaches any driver (AGENTS.md #6), and errors
// map to the envelope.

/** One brain's three channels — what every handler below operates on. */
export type ApiContext = BrainChannels;

// --- validation patterns (single place, no scattered regexes) --------------

const SLUG_RE = /^[a-zA-Z0-9][a-zA-Z0-9/_.-]{0,200}$/;
const TYPE_RE = /^[a-z][a-z0-9-]{0,40}$/;
/**
 * Tag values are "plain strings like 'founder' or 'follow-up', not a slug"
 * (add_tag's own description) — bounded + control-char-free is the whole
 * contract; deliberately NOT TYPE_RE, which would reject real tags.
 */
const TAG_RE = /^[^\x00-\x1f\x7f]{1,64}$/;
/** trust refs — the single shared pattern (shared/src, also used by the web client) */
const REF_RE = TRUST_REF_RE;
const ID_RE = /^\d{1,18}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const REQUEST_ID_RE = /^[0-9a-fA-F-]{8,64}$/;
/** updated_at echoes (list_pages keyset cursor values) — ISO-ish, bounded */
const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}(T[\d:.]{1,15}(Z|[+-]\d{2}:?\d{2})?)?$/;

function param(url: URL, name: string): string | undefined {
  const value = url.searchParams.get(name) ?? undefined;
  return value === "" ? undefined : value;
}

function requirePattern(value: string | undefined, name: string, re: RegExp): string {
  if (value === undefined || !re.test(value)) {
    throw new BadRequestError(`invalid ${name}`);
  }
  return value;
}

// --- error mapping ----------------------------------------------------------

export function mapError(err: unknown): Response {
  if (err instanceof BadRequestError || err instanceof CliValidationError) {
    return envelope(400, "E_BAD_REQUEST", err.message);
  }
  if (err instanceof TakesSourceGuardError) {
    // The source-scoped takes guard refused the exec (brain config/database
    // mismatch, or an upstream source_id outside gbrain's env charset).
    // The guard's messages carry database NAMES only, never URLs — safe to
    // surface so the operator can fix the deployment.
    return envelope(502, "E_UPSTREAM", err.message);
  }
  if (err instanceof CliExecutionError) {
    // The gbrain CLI ran and failed (nonzero exit, ENOENT, timeout). The
    // driver bounds the message to the first stderr line, so surfacing it
    // lets the operator act ("No brain directory configured…") instead of
    // staring at an opaque 500. Same envelope shape as MCP upstream errors.
    return envelope(
      err.timedOut ? 504 : 502,
      "E_UPSTREAM",
      err.message,
    );
  }
  if (err instanceof McpError) {
    switch (err.kind) {
      case "auth":
        return envelope(502, "E_UPSTREAM_AUTH", err.message);
      case "denied":
        // gbrain's grant refused the call (source outside federated_read) —
        // upstream's denial relayed verbatim, never cockpit's own verdict.
        return envelope(502, "E_UPSTREAM_AUTH", err.message);
      case "unknown-source":
        // the named source is gone (removed/archived) — the caller's problem
        return envelope(400, "E_BAD_REQUEST", err.message);
      case "rate-limit":
        return envelope(429, "E_RATE_LIMITED", err.message, {
          ...(err.retryAfterMs
            ? { "retry-after": String(Math.ceil(err.retryAfterMs / 1000)) }
            : {}),
        });
      case "timeout":
        return envelope(504, "E_UPSTREAM", err.message);
      default:
        return envelope(502, "E_UPSTREAM", err.message);
    }
  }
  console.error("[api] unexpected error:", err);
  return envelope(500, "E_INTERNAL", "unexpected server error");
}

// --- graph (read-only bypass, Nebula's only data source) ----------------------

export async function handleGraph(ctx: ApiContext): Promise<Response> {
  if (!ctx.pg || !ctx.pg.configured) {
    // Not an error: PGLite engines and hosts without the bypass simply leave
    // the DSN unset. The UI degrades with a bilingual note.
    const down: GraphReport = {
      status: "down",
      error:
        "read-only bypass not configured (PG_READONLY_DSN unset — PGLite engines leave it unset)",
    };
    return Response.json(down);
  }
  try {
    const { snapshot, stale, error } = await ctx.pg.getGraph();
    const report: GraphReport = {
      status: stale ? "degraded" : "ok",
      fingerprint: snapshot.fingerprint,
      stale,
      generatedAt: new Date().toISOString(),
      ...(error ? { error } : {}),
      nodes: snapshot.nodes,
      edges: snapshot.edges,
    };
    return Response.json(report);
  } catch (err) {
    // Channel-down reads report in-band (same vocabulary as inbox queues);
    // the MCP-composite fallback chain is a later milestone (ARCHITECTURE §3.3).
    const down: GraphReport = {
      status: "down",
      error: err instanceof Error ? err.message : String(err),
    };
    return Response.json(down);
  }
}

// --- read routes ------------------------------------------------------------

export async function handlePages(
  ctx: ApiContext,
  url: URL,
): Promise<Response> {
  const type = param(url, "type");
  if (type !== undefined) requirePattern(type, "type", TYPE_RE);
  const limitRaw = param(url, "limit") ?? "50";
  const limit = Number.parseInt(limitRaw, 10);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new BadRequestError("invalid limit (1..100)");
  }
  // Deep paging rides upstream's offset param — probed 0.60.558: offset
  // windows are strictly descending, non-overlapping and stable across
  // calls. The documented keyset pair (updated_after/updated_after_slug)
  // is ALSO accepted here but on this build behaves as an ascending
  // "newer-than" window filter (sort ignored), not a cursor — see
  // internal/probes/probe-keyset.ts before ever switching back.
  const offsetRaw = param(url, "offset") ?? "0";
  const offset = Number.parseInt(offsetRaw, 10);
  if (!Number.isInteger(offset) || offset < 0 || offset > 100_000) {
    throw new BadRequestError("invalid offset (0..100000)");
  }
  const updatedAfter = param(url, "updated_after");
  if (updatedAfter !== undefined) {
    requirePattern(updatedAfter, "updated_after", TIMESTAMP_RE);
  }
  const updatedAfterSlug = param(url, "updated_after_slug");
  if (updatedAfterSlug !== undefined) {
    requirePattern(updatedAfterSlug, "updated_after_slug", SLUG_RE);
  }
  // slug dimension: literal slug_prefix narrowing ("kb/" style, probed)
  const slugPrefix = param(url, "slug_prefix");
  if (slugPrefix !== undefined) {
    requirePattern(slugPrefix, "slug_prefix", SLUG_RE);
  }
  // tag dimension: free-input tag filter (param exists upstream; the probed
  // brain has no tagged pages yet, so empty results there are honest)
  const tag = param(url, "tag");
  if (tag !== undefined) requirePattern(tag, "tag", TAG_RE);
  const sourceId = requireSourceId(url);
  const pages = await ctx.mcp.listPages({
    ...(type ? { type } : {}),
    limit,
    sort: "updated_desc",
    ...(offset > 0 ? { offset } : {}),
    ...(updatedAfter ? { updatedAfter } : {}),
    ...(updatedAfterSlug ? { updatedAfterSlug } : {}),
    ...(slugPrefix ? { slugPrefix } : {}),
    ...(tag ? { tag } : {}),
    ...(sourceId ? { sourceId } : {}),
  });
  return Response.json(pages satisfies PageSummary[]);
}

export async function handlePageFacets(ctx: ApiContext): Promise<Response> {
  const stats = await ctx.mcp.schemaStats();
  // gbrain nests the counters under `aggregate`; normalize here so the UI
  // never depends on the raw shape (narrow adaptation surface).
  const agg = (stats.aggregate ?? {}) as {
    total_pages?: number;
    by_type?: PagesFacets["by_type"];
  };
  const facets: PagesFacets = {
    pack_identity: stats.pack_identity,
    total_pages: agg.total_pages,
    by_type: agg.by_type ?? [],
  };
  return Response.json(facets);
}

export async function handlePage(
  ctx: ApiContext,
  url: URL,
): Promise<Response> {
  const slug = requirePattern(param(url, "slug"), "slug", SLUG_RE);
  // (source_id, slug) is the page identity: with same-slug pages in two
  // sources, a bare slug is resolved SILENTLY server-side — pass the source
  // whenever the caller has it (list/search/graph entries all carry it).
  const sourceId = requireSourceId(url);
  // full=1 opts into the V1.1 provenance sections (links / backlinks /
  // timeline). Without it the payload stays {page, versions} — the peek
  // drawers' path keeps its 2-upstream-call cost (rate-budget discipline).
  const full = url.searchParams.get("full") === "1";
  if (!full) {
    const [page, versions] = await Promise.all([
      ctx.mcp.getPage(slug, sourceId),
      ctx.mcp.versions(slug).catch(() => [] as PageVersion[]),
    ]);
    return Response.json({ page: page satisfies PageDetail, versions });
  }
  // Sections degrade in-band: a missing/failed section lands in `degraded`
  // and the UI self-describes it; only the page itself is allowed to error.
  // Sections attach only when fulfilled, so an old-server payload and a
  // degraded section are indistinguishable on the client (by design).
  const [pageR, versionsR, linksR, backlinksR, timelineR] = await Promise.allSettled([
    ctx.mcp.getPage(slug, sourceId),
    ctx.mcp.versions(slug),
    ctx.mcp.getLinks(slug, sourceId),
    ctx.mcp.getBacklinks(slug, sourceId),
    ctx.mcp.getTimeline(slug),
  ]);
  if (pageR.status === "rejected") throw pageR.reason;
  const page = pageR.value;
  const versions = versionsR.status === "fulfilled" ? versionsR.value : [];
  const degraded: string[] = [];
  if (versionsR.status === "rejected") degraded.push("versions");
  const links = linksR.status === "fulfilled" ? linksR.value : undefined;
  if (linksR.status === "rejected") degraded.push("links");
  const backlinks =
    backlinksR.status === "fulfilled" ? backlinksR.value : undefined;
  if (backlinksR.status === "rejected") degraded.push("backlinks");
  const timeline =
    timelineR.status === "fulfilled" ? (timelineR.value as TimelineEntry[]) : undefined;
  if (timelineR.status === "rejected") degraded.push("timeline");
  return Response.json({
    page: page satisfies PageDetail,
    versions,
    ...(links !== undefined ? { links: links satisfies LinkRow[] } : {}),
    ...(backlinks !== undefined ? { backlinks: backlinks satisfies LinkRow[] } : {}),
    ...(timeline !== undefined ? { timeline: timeline satisfies TimelineEntry[] } : {}),
    ...(degraded.length > 0 ? { degraded } : {}),
  });
}

export async function handleSearch(
  ctx: ApiContext,
  url: URL,
): Promise<Response> {
  const raw = param(url, "q");
  if (raw === undefined || raw.length < 1 || raw.length > 200) {
    throw new BadRequestError("q is required (1..200 chars)");
  }
  // strip control characters; the rest is passed verbatim as a search term
  const q = raw.replace(/[\x00-\x1f\x7f]/g, "");
  const mode = param(url, "mode");
  if (mode !== undefined && mode !== "literal" && mode !== "semantic") {
    throw new BadRequestError("mode must be literal|semantic");
  }
  const sourceId = requireSourceId(url);
  if (mode === "semantic") {
    // the query tool's own response shape varies — normalize to SearchHit[]
    // so the panel renders one list, whichever engine answered
    const r: unknown = await ctx.mcp.query(q, sourceId);
    const rows: unknown[] = Array.isArray(r)
      ? r
      : r !== null &&
          typeof r === "object" &&
          Array.isArray((r as Record<string, unknown>).results)
        ? ((r as Record<string, unknown>).results as unknown[])
        : [];
    return Response.json(rows as SearchHit[]);
  }
  const hits = await ctx.mcp.search(q, sourceId);
  return Response.json(hits satisfies SearchHit[]);
}

/**
 * GET /api/sources — the source axis' option list. In-band degraded like
 * every other channel report: an older gbrain without sources_list (or a
 * dead MCP) yields a non-ok status and the UI falls back to observed ids.
 */
export async function handleSources(ctx: ApiContext): Promise<Response> {
  try {
    const items = await ctx.mcp.sourcesList();
    const report: SourcesReport = { status: "ok", items };
    return Response.json(report);
  } catch (err) {
    const report: SourcesReport = {
      status:
        err instanceof McpError && err.kind === "protocol" ? "degraded" : "down",
      error: err instanceof Error ? err.message : String(err),
    };
    return Response.json(report);
  }
}

/** source_id param: valid charset, never the reserved '__all__' wildcard. */
function requireSourceId(url: URL): string | undefined {
  const raw = param(url, "source_id");
  if (raw === undefined) return undefined;
  if (!isValidSourceId(raw)) {
    throw new BadRequestError("invalid source_id");
  }
  return raw;
}

// --- V1.1 write-receipt transparency & source diagnostics --------------------

/** In-band status: a protocol error means "this gbrain lacks the tool"
 *  (degraded); anything else is a channel failure (down). Same vocabulary
 *  as handleSources. */
function reportStatus(err: unknown): "degraded" | "down" {
  return err instanceof McpError && err.kind === "protocol" ? "degraded" : "down";
}

/**
 * GET /api/write-requests — the token's own write receipts, newest first
 * (gbrain-side truth; the session audit log stays the other, client-side
 * history). NOTE: distinct from singular GET /api/write-request, which polls
 * ONE receipt by request_id.
 */
export async function handleWriteRequests(
  ctx: ApiContext,
  url: URL,
): Promise<Response> {
  const sourceId = requireSourceId(url);
  const limitRaw = param(url, "limit") ?? "50";
  const limit = Number.parseInt(limitRaw, 10);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new BadRequestError("invalid limit (1..100)");
  }
  try {
    const items = await ctx.mcp.listWriteRequests({
      ...(sourceId ? { sourceId } : {}),
      limit,
    });
    const report: WriteRequestsReport = { status: "ok", items };
    return Response.json(report);
  } catch (err) {
    const report: WriteRequestsReport = {
      status: reportStatus(err),
      error: err instanceof Error ? err.message : String(err),
    };
    return Response.json(report);
  }
}

/** GET /api/write-conflicts — pages whose writes keep ending source_changed. */
export async function handleWriteConflicts(
  ctx: ApiContext,
  url: URL,
): Promise<Response> {
  const sourceId = requireSourceId(url);
  try {
    const items = await ctx.mcp.listWriteConflicts(
      sourceId ? { sourceId } : {},
    );
    const report: WriteConflictsReport = { status: "ok", items };
    return Response.json(report);
  } catch (err) {
    const report: WriteConflictsReport = {
      status: reportStatus(err),
      error: err instanceof Error ? err.message : String(err),
    };
    return Response.json(report);
  }
}

/**
 * GET /api/sources/status — per-source diagnostics for the Health card.
 * sources_status diagnoses ONE source per call (arg `id`), so this fans out
 * over the (cached, grant-scoped) source list; a failing source degrades the
 * whole report while its row carries the error.
 */
export async function handleSourcesStatus(ctx: ApiContext): Promise<Response> {
  let sources: Array<{ id: string }>;
  try {
    sources = await ctx.mcp.sourcesList();
  } catch (err) {
    const report: SourcesStatusReport = {
      status: reportStatus(err),
      error: err instanceof Error ? err.message : String(err),
    };
    return Response.json(report);
  }
  const results = await Promise.allSettled(
    sources.map((s) => ctx.mcp.sourcesStatus(s.id)),
  );
  const items: SourceDiagnostic[] = results.map((r, i) => {
    if (r.status === "fulfilled") return r.value;
    const err = r.reason;
    return {
      id: sources[i]?.id ?? "?",
      error: err instanceof Error ? err.message : String(err),
    };
  });
  const failed = results.filter((r) => r.status === "rejected").length;
  const report: SourcesStatusReport = {
    status: failed === 0 ? "ok" : failed === results.length ? "down" : "degraded",
    ...(failed > 0
      ? {
          error: `${failed}/${results.length} source diagnostic(s) failed`,
        }
      : {}),
    items,
  };
  return Response.json(report);
}

// --- ops (0.4.0 management surface) -------------------------------------------
// MANAGEMENT_CHANNELS: same co-located CLI whitelist as adjudication, plus
// the pg bypass for whole-database views. Reads ride the base token; the
// WRITE (grant-read) additionally requires the admin tier (D6 amendment).
// Every cell of the degradation matrix answers in-band, never a 500.

/** Scoped exec opts for management verbs: the guard's brain-scoped direct
 *  call when the profile has the gbrainBin/gbrainHome pair, else the plain
 *  profile CLI with the inherited env (operator-bound single-brain path). */
async function managementExecOpts(ctx: ApiContext): Promise<ScopedExecOpts> {
  if (ctx.takesGuard) {
    const scoped = await ctx.takesGuard.brainExec();
    return { bin: scoped.bin, env: scoped.env };
  }
  return {};
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value.filter((v): v is string => typeof v === "string");
  return out.length === value.length ? out : undefined;
}

/**
 * GET /api/ops/sources-drift — pg sees the whole database, MCP sees granted
 * sources; `missing` = pages exist AND the source is active AND the client
 * cannot read it. The active-source gate is load-bearing: upstream rescope
 * does NOT validate federated ids for activeness, and granting an archived
 * one would brick the client's token issuance (probe 2026-11-09).
 */
export async function handleOpsSourceDrift(ctx: ApiContext): Promise<Response> {
  const report: OpsSourceDriftReport = {
    status: "ok",
    missing: [],
    action: { available: false },
  };

  let pgSources: OpsSourcePages[] | undefined;
  try {
    pgSources = await ctx.pg.sourcesWithPages();
    report.pgSources = pgSources;
  } catch (err) {
    report.status = "degraded";
    report.error = err instanceof Error ? err.message : String(err);
  }

  let activeSources: string[] | undefined;
  let clientRow: OpsClientGrant | undefined;
  if (ctx.cli) {
    try {
      const opts = await managementExecOpts(ctx);
      const clientId = ctx.profile.oauth?.clientId;
      const [sourcesEnv, clientsEnv] = await Promise.all([
        ctx.cli.sourcesListJson(opts),
        ctx.cli.authClients(opts),
      ]);
      activeSources = (sourcesEnv.sources ?? [])
        .filter((s) => s.archived !== true)
        .map((s) => s.id);
      if (clientId) {
        clientRow = clientsEnv.clients?.find((c) => c.client_id === clientId);
      }
      report.activeSources = activeSources;
    } catch {
      // CLI present but the management verbs failed — degrade the grant set
      // to the whoami fallback below; never fail the whole card.
    }
  }

  // Granted set: the client row is ground truth; whoami's capabilities
  // spread is the CLI-unavailable fallback (OAuth transports carry
  // federated_read there — gbrain 0.60.558, shared McpWhoami doc).
  let grantedSources = stringArray(clientRow?.federated_read);
  if (grantedSources === undefined) {
    try {
      const whoami = await ctx.mcp.whoami({ timeoutMs: 4_000 });
      grantedSources = stringArray(whoami.federated_read);
    } catch {
      // unknown is not "all granted" — missing stays conservative below
    }
  }
  if (grantedSources !== undefined) report.grantedSources = grantedSources;

  if (pgSources && grantedSources !== undefined) {
    const granted = new Set(grantedSources);
    report.missing = pgSources
      .map((p) => p.source_id)
      .filter(
        (id) =>
          !granted.has(id) &&
          (activeSources === undefined || activeSources.includes(id)),
      );
  }

  // Action availability + the copy-command fallback. The command is built
  // ONLY when every to-be-added id is verifiably active (CLI healthy) —
  // pasting a list containing an archived id would brick token issuance.
  const clientId = ctx.profile.oauth?.clientId;
  if (!ctx.cli) {
    report.action = { available: false, reason: "cli-unavailable" };
  } else if (!clientId) {
    report.action = { available: false, reason: "not-oauth-profile" };
  } else if (!pgSources) {
    report.action = { available: false, reason: "pg-unavailable" };
  } else {
    report.action = { available: true };
    const additions = (report.missing ?? []).filter(
      (id) => activeSources?.includes(id) === true,
    );
    if (additions.length > 0 && grantedSources !== undefined && clientRow) {
      try {
        report.action = {
          available: true,
          command: authRescopeCommand(
            ctx.profile.cliBin ?? "gbrain",
            clientId,
            [...new Set([...grantedSources, ...additions])],
          ),
        };
      } catch {
        // builder refused (charset/bin) — the action still runs one-key
      }
    }
  }
  return Response.json(report);
}

/** GET /api/ops/dream-runs — proposal ACTIVITY (never "dream liveness") plus
 *  upstream's cycle_freshness verdict. The doctor call is cached briefly:
 *  the check reads config jsonbs (fast) but the card refreshes often. */
const DOCTOR_CACHE_TTL_MS = 60_000;
const doctorCache = new Map<string, { at: number; value: OpsDreamRunsReport["cycleFreshness"] }>();

async function cycleFreshness(ctx: ApiContext): Promise<OpsDreamRunsReport["cycleFreshness"]> {
  const cached = doctorCache.get(ctx.id);
  if (cached && Date.now() - cached.at < DOCTOR_CACHE_TTL_MS) return cached.value;
  let value: OpsDreamRunsReport["cycleFreshness"];
  if (!ctx.cli) {
    value = undefined;
  } else {
    try {
      const opts = await managementExecOpts(ctx);
      const env = await ctx.cli.doctorCycleFreshness(opts);
      const check = env.checks?.find((c) => c.name === "cycle_freshness");
      const status =
        check?.status === "ok" || check?.status === "warn" || check?.status === "fail"
          ? check.status
          : "unknown";
      value = {
        status,
        ...(typeof check?.message === "string" ? { message: check.message } : {}),
      };
    } catch (err) {
      // Structured status only; the error text is diagnostics, not parsed —
      // but never silent: an ops check that stops answering must be visible
      // in the server log (probe drift shows up here first).
      console.warn(
        `[ops] doctor cycle_freshness failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      value = { status: "unknown" };
    }
  }
  doctorCache.set(ctx.id, { at: Date.now(), value });
  return value;
}

export async function handleOpsDreamRuns(ctx: ApiContext): Promise<Response> {
  const report: OpsDreamRunsReport = {
    status: "ok",
    neverRan: false,
  };
  let runs: OpsDreamRun[];
  try {
    runs = await ctx.pg.dreamRuns();
  } catch (err) {
    const down: OpsDreamRunsReport = {
      status: reportStatus(err),
      neverRan: false,
      error: err instanceof Error ? err.message : String(err),
    };
    return Response.json(down);
  }
  report.runs = runs;
  report.neverRan = runs.length === 0;
  report.lastActivityAt = runs[0]?.end;
  report.pendingTotal = runs.reduce((sum, r) => sum + r.pending, 0);
  report.cycleFreshness = await cycleFreshness(ctx);
  return Response.json(report);
}

/** POST /api/ops/grant-read — widen cockpit's own client to every active
 *  source that has pages. ZERO request parameters: the client id comes from
 *  the profile's credentials file, the new list is computed server-side as
 *  current ∪ (pg ∩ active) — a pure union that never revokes and never
 *  names an id upstream would reject. Admin tier + single-flight per profile. */
const grantLocks = new Map<string, Promise<OpsGrantReadResult>>();

export async function handleOpsGrantRead(
  ctx: ApiContext,
  principal: Principal,
  adminConfigured: boolean,
): Promise<Response> {
  if (principal.tier !== "admin") {
    return envelope(
      403,
      "E_FORBIDDEN",
      adminConfigured
        ? "management writes require the COCKPIT_ADMIN_TOKEN tier — paste it at the action's step-up prompt"
        : "COCKPIT_ADMIN_TOKEN is not configured on this cockpit — set it in the server env, or use the copy-command on the brain host",
    );
  }
  const inflight = grantLocks.get(ctx.id);
  if (inflight) return Response.json(await inflight);
  const run = runGrantRead(ctx).finally(() => grantLocks.delete(ctx.id));
  grantLocks.set(ctx.id, run);
  return Response.json(await run);
}

async function runGrantRead(ctx: ApiContext): Promise<OpsGrantReadResult> {
  if (!ctx.cli) {
    throw new CliExecutionError(
      "CLI channel unavailable on this host — use the copy-command instead",
    );
  }
  const clientId = ctx.profile.oauth?.clientId;
  if (!clientId) {
    throw new CliExecutionError(
      "this profile is not an OAuth client (legacy bearer token) — grant widening applies to client-credentials profiles only",
    );
  }
  const opts = await managementExecOpts(ctx);
  const clientsEnv = await ctx.cli.authClients(opts);
  const row = clientsEnv.clients?.find((c) => c.client_id === clientId);
  if (!row) {
    throw new CliExecutionError(
      "auth clients: cockpit's own client row is missing (revoked?) — re-run `gbrain mcp grant` on the brain host",
    );
  }
  const current = stringArray(row.federated_read) ?? [];

  const [pgSources, sourcesEnv] = await Promise.all([
    ctx.pg.sourcesWithPages(),
    ctx.cli.sourcesListJson(opts),
  ]);
  const active = new Set(
    (sourcesEnv.sources ?? [])
      .filter((s) => s.archived !== true)
      .map((s) => s.id),
  );
  const candidates = pgSources
    .map((p) => p.source_id)
    .filter((id) => active.has(id));
  const added = candidates.filter((id) => !current.includes(id));
  if (added.length === 0) {
    return { status: "ok", added: [], federatedRead: current };
  }

  const merged = [...new Set([...current, ...candidates])];
  await ctx.cli.authRescope(clientId, merged, opts);

  // Verify the grant took (protocol-drift tripwire), then make the new
  // scope live NOW: force-mint a fresh access token + drop read caches.
  const after = await ctx.cli.authClients(opts);
  const afterRow = after.clients?.find((c) => c.client_id === clientId);
  const afterList = stringArray(afterRow?.federated_read) ?? [];
  if (added.some((id) => !afterList.includes(id))) {
    throw new CliExecutionError(
      "auth rescope reported success but the client row does not carry the new sources (protocol drift? re-run probes)",
    );
  }
  await ctx.mcp.forceRenew();
  ctx.mcp.invalidateAll();
  await auditWrite("owner (admin)", {
    action: "ops.grant-read",
    profile: ctx.id,
    detail: {
      added,
      federated_read: afterList,
      client_id: clientId,
    },
  });
  return { status: "ok", added, federatedRead: afterList };
}

/**
 * POST /api/evidence — whole evidence for prior search hits (assemble_evidence,
 * minimal V1.1 form: ≤3 triples per call, window unit around the hit chunk).
 */
export async function handleEvidence(
  ctx: ApiContext,
  req: Request,
): Promise<Response> {
  const body = await readJsonBody(req);
  const rawHits = body.hits;
  if (!Array.isArray(rawHits) || rawHits.length < 1 || rawHits.length > 3) {
    throw new BadRequestError("hits must be an array of 1..3 search hits");
  }
  const hits = rawHits.map((h) => {
    if (h === null || typeof h !== "object") {
      throw new BadRequestError("each hit must be an object");
    }
    const hit = h as Record<string, unknown>;
    const slug =
      typeof hit.slug === "string" && SLUG_RE.test(hit.slug) ? hit.slug : undefined;
    const sourceId =
      typeof hit.source_id === "string" && isValidSourceId(hit.source_id)
        ? hit.source_id
        : undefined;
    const chunkId =
      typeof hit.chunk_id === "number" &&
      Number.isInteger(hit.chunk_id) &&
      hit.chunk_id >= 0 &&
      hit.chunk_id <= 1_000_000_000
        ? hit.chunk_id
        : undefined;
    if (slug === undefined || sourceId === undefined || chunkId === undefined) {
      throw new BadRequestError(
        "each hit needs valid slug, source_id and integer chunk_id",
      );
    }
    return { sourceId, slug, chunkId };
  });
  try {
    const payload = await ctx.mcp.assembleEvidence(hits, {
      returnUnit: "window",
    });
    const report: EvidenceReport = {
      status: "ok",
      results: payload.results ?? [],
      ...(Array.isArray(payload.unresolved) && payload.unresolved.length > 0
        ? { unresolved: payload.unresolved }
        : {}),
    };
    return Response.json(report);
  } catch (err) {
    const report: EvidenceReport = {
      status: reportStatus(err),
      error: err instanceof Error ? err.message : String(err),
    };
    return Response.json(report);
  }
}

// --- inbox ------------------------------------------------------------------

async function trustQueue(
  ctx: ApiContext,
): Promise<InboxQueue<TrustReviewItem>> {
  if (!ctx.cli) {
    return {
      status: "down",
      error: "CLI channel unavailable — actions degrade to copy-command",
    };
  }
  try {
    const envelopeData = await ctx.cli.trustReview();
    return {
      status: "ok",
      items: envelopeData.items ?? [],
      counts: envelopeData.counts,
    } satisfies InboxQueue<TrustReviewItem> & { counts?: Record<string, number> };
  } catch (err) {
    return {
      status: "down",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function edgeQueue(
  ctx: ApiContext,
): Promise<InboxQueue<EdgeProposal>> {
  if (!ctx.cli) {
    return {
      status: "down",
      error: "CLI channel unavailable — actions degrade to copy-command",
    };
  }
  try {
    const items = await ctx.cli.edgeList();
    return { status: "ok", items };
  } catch (err) {
    return {
      status: "down",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function takesQueue(ctx: ApiContext): Promise<TakesQueue> {
  // The pending-takes queue reads the read-only bypass, NOT the CLI:
  // gbrain's `takes propose` list scopes to ONE source per run
  // (resolveSourceId → 'default' without GBRAIN_SOURCE), so on a
  // multi-source brain the CLI silently hides every other source's
  // proposals — the table read is naturally cross-source (probed on
  // 0.60.558, GBRAIN-CAPABILITIES §2 hidden-family row). Adjudication
  // (accept/reject) stays on the CLI channel — it is the only writer.
  if (!ctx.pg?.configured) {
    return {
      status: "down",
      error:
        "takes queue reads the read-only bypass — set pgReadonlyDsn on this profile (and grant its account SELECT on take_proposals)",
    };
  }
  try {
    const items = await ctx.pg.pendingTakeProposals();
    // companion view: extraction repeatedly failed & held (read-only; the
    // release verb --retry-failed stays an owner action)
    let failed: TakesQueue["failed"];
    if (ctx.cli) {
      try {
        const r: unknown = await ctx.cli.takesFailedList();
        const rows: unknown[] = Array.isArray(r)
          ? r
          : r !== null &&
              typeof r === "object" &&
              Array.isArray((r as Record<string, unknown>).failed)
            ? ((r as Record<string, unknown>).failed as unknown[])
            : [];
        failed = {
          status: "ok",
          items: rows as NonNullable<TakesQueue["failed"]>["items"],
        };
      } catch (err) {
        failed = {
          status: "down",
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }
    return {
      status: "ok",
      items,
      ...(failed ? { failed } : {}),
      // Degraded-rail copy-commands are built SERVER-side: only the server
      // holds the direct-call materials (gbrainBin/gbrainHome never leave
      // it), and on a multi-source brain the naive `${bin} takes propose`
      // wrapper form is known-bad for any row outside the default source —
      // the 0.2.2 bug, degraded form (hotfix 0.2.3).
      commands: buildTakeQueueCommands(items, {
        cliBin: ctx.profile.cliBin ?? "gbrain",
        ...(ctx.takesGuard
          ? { guard: { bin: ctx.takesGuard.bin, home: ctx.takesGuard.home } }
          : {}),
      }),
    };
  } catch (err) {
    return {
      status: "down",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function contradictionsQueue(
  ctx: ApiContext,
): Promise<ContradictionsReport> {
  // Lane = decide-family proposals (the CLI queue, same shape as edges) +
  // the eval probe's last-run state (the MCP read, informational header).
  // The two halves degrade independently: a down CLI still shows the probe
  // state, an unreachable MCP still lists proposals.
  const probeP = ctx.mcp
    .findContradictions()
    .then(
      (p): ContradictionsReport["probe"] => ({
        ...(typeof p.ran_at === "string" ? { ranAt: p.ran_at } : {}),
        ...(typeof p.run_id === "string" ? { runId: p.run_id } : {}),
        ...(typeof p.note === "string" ? { note: p.note } : {}),
        ...(typeof p.total_visible === "number"
          ? { totalVisible: p.total_visible }
          : {}),
      }),
    )
    .catch(() => undefined);
  if (!ctx.cli) {
    const probe = await probeP;
    return {
      status: "down",
      error: "CLI channel unavailable — actions degrade to copy-command",
      ...(probe ? { probe } : {}),
    };
  }
  try {
    const [envelope, probe] = await Promise.all([
      ctx.cli.decideProposalsList(),
      probeP,
    ]);
    const items = Array.isArray(envelope.proposals)
      ? (envelope.proposals as ContradictionProposal[])
      : [];
    return {
      status: "ok",
      items,
      ...(probe ? { probe } : {}),
    };
  } catch (err) {
    const probe = await probeP.catch(() => undefined);
    return {
      status: "down",
      error: err instanceof Error ? err.message : String(err),
      ...(probe ? { probe } : {}),
    };
  }
}

/** Read-only entity-stub lane (the dispose verb is owner-only upstream). */
async function extractionQueue(ctx: ApiContext): Promise<ExtractionQueue> {
  try {
    const r = await ctx.mcp.extractionPending();
    const pending = Array.isArray(r.pending) ? r.pending : [];
    return {
      status: "ok",
      items: pending as ExtractionStub[],
      ...(typeof r.unattributed?.count === "number"
        ? { unattributedCount: r.unattributed.count }
        : {}),
      ...(typeof r.possible_duplicates?.count === "number"
        ? { duplicatesCount: r.possible_duplicates.count }
        : {}),
    };
  } catch (err) {
    return {
      status: reportStatus(err),
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** ACTIVE takes awaiting judgment — takes_resolve closes the loop. */
async function activeTakesQueue(ctx: ApiContext): Promise<InboxQueue<TakeItem>> {
  try {
    const items = await ctx.mcp.takesList({ active: true });
    return { status: "ok", items };
  } catch (err) {
    return {
      status: reportStatus(err),
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function handleInbox(ctx: ApiContext): Promise<Response> {
  const [trust, edgeProposals, takes, contradictions, extraction, activeTakes] =
    await Promise.all([
      trustQueue(ctx),
      edgeQueue(ctx),
      takesQueue(ctx),
      contradictionsQueue(ctx),
      extractionQueue(ctx),
      activeTakesQueue(ctx),
    ]);
  // The command name comes from the profile config (wrapper brains like
  // `gbrain-bip` exist); it is present even when the CLI driver itself is
  // down — copy-commands are the fallback, they must never go blank.
  // `reason` carries the same vocabulary as the Health CLI card, so the
  // Inbox chip can tell "binary missing (maybe not the brain host)" apart
  // from "binary found, probe unverified" instead of blaming the host for
  // both. cliNote (dual-brain hosts: which cliBin failed to resolve) beats
  // the generic message, matching what Health shows.
  const probe = ctx.cli ? await ctx.cli.status() : null;
  const cliChannel: CliChannelStatus = probe
    ? {
        ...probe,
        reason: cliReason(ctx.cli, probe.available),
        command: ctx.profile.cliBin ?? "gbrain",
      }
    : {
        available: false,
        reason: cliReason(null, false),
        command: ctx.profile.cliBin ?? "gbrain",
        error: ctx.cliNote ?? "gbrain binary not found",
      };
  const report: InboxReport = {
    trust,
    edgeProposals,
    takes,
    contradictions,
    extraction,
    activeTakes,
    cliChannel,
  };
  return Response.json(report);
}

/** GET /api/profiles — the switcher's data: ids, labels, zero secrets. */
export async function handleProfiles(
  registry: BrainRegistry,
): Promise<Response> {
  const body: ProfilesResponse = await registry.profileInfos();
  return Response.json(body);
}

// --- adjudication actions ---------------------------------------------------

export async function handleTrustDrop(
  ctx: ApiContext,
  req: Request,
): Promise<Response> {
  const body = await readJsonBody(req);
  const ref = requirePattern(
    typeof body.ref === "string" ? body.ref : undefined,
    "ref",
    REF_RE,
  );
  if (!ctx.cli) {
    return envelope(
      503,
      "E_UPSTREAM",
      "CLI channel unavailable on this host — use the copy-command instead",
    );
  }
  const result = await ctx.cli.trustDrop(ref);
  ctx.mcp.invalidateAll();
  await auditWrite("owner", {
    action: "trust.drop",
    profile: ctx.id,
    detail: { ref },
  });
  return Response.json({ ok: true, output: result.output });
}

export async function handleEdgeAction(
  ctx: ApiContext,
  req: Request,
): Promise<Response> {
  const body = await readJsonBody(req);
  const op = body.op;
  const id = requirePattern(
    typeof body.id === "string" ? body.id : undefined,
    "id",
    ID_RE,
  );
  if (!ctx.cli) {
    return envelope(
      503,
      "E_UPSTREAM",
      "CLI channel unavailable on this host — use the copy-command instead",
    );
  }
  let result: { output: string };
  switch (op) {
    case "accept":
      result = await ctx.cli.edgeAccept(id);
      break;
    case "reject":
      result = await ctx.cli.edgeReject(id);
      break;
    case "undo":
      result = await ctx.cli.edgeUndo(id);
      break;
    case "date":
      result = await ctx.cli.edgeDate(
        id,
        requirePattern(
          typeof body.date === "string" ? body.date : undefined,
          "date",
          DATE_RE,
        ),
      );
      break;
    default:
      throw new BadRequestError("op must be accept|reject|undo|date");
  }
  ctx.mcp.invalidateAll();
  await auditWrite("owner", {
    action: `edge-proposals.${op}`,
    profile: ctx.id,
    detail: { id },
  });
  return Response.json({ ok: true, output: result.output });
}

export async function handleTakePropose(
  ctx: ApiContext,
  req: Request,
): Promise<Response> {
  const body = await readJsonBody(req);
  const op = body.op;
  if (op !== "accept" && op !== "reject") {
    throw new BadRequestError("op must be accept|reject");
  }
  const id = requirePattern(
    typeof body.id === "string" ? body.id : String(body.id ?? ""),
    "id",
    ID_RE,
  );
  if (!ctx.cli) {
    return envelope(
      503,
      "E_UPSTREAM",
      "CLI channel unavailable on this host — use the copy-command instead",
    );
  }
  // Multi-source brains: the CLI verb scopes to ONE source per run, so the
  // exec must carry the proposal row's own source. The row comes from the
  // same read-only queue the Inbox renders (server-authoritative, never
  // client-shaped), the guard re-asserts the brain's database before every
  // exec, and only then does the real binary run with GBRAIN_SOURCE set.
  let scoped: { bin?: string; env?: Record<string, string> } = {};
  let sourceId: string | undefined;
  if (ctx.takesGuard) {
    if (!ctx.pg?.configured) {
      return envelope(
        503,
        "E_UPSTREAM",
        "cannot resolve the proposal's source: the read-only bypass is unavailable — use the copy-command instead",
      );
    }
    let pending: TakeProposal[];
    try {
      pending = await ctx.pg.pendingTakeProposals();
    } catch (err) {
      return envelope(
        502,
        "E_UPSTREAM",
        `cannot read the pending queue to resolve the proposal's source: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const row = pending.find((p) => String(p.id) === id);
    if (!row?.source_id) {
      return envelope(
        404,
        "E_NOT_FOUND",
        `proposal #${id} is not in the pending queue — already adjudicated, or invisible to the read-only account`,
      );
    }
    sourceId = row.source_id;
    scoped = await ctx.takesGuard.scopedExec(row.source_id);
  }
  const result =
    op === "accept"
      ? await ctx.cli.takesProposeAccept(id, scoped)
      : await ctx.cli.takesProposeReject(id, scoped);
  ctx.mcp.invalidateAll();
  await auditWrite("owner", {
    action: `takes.propose.${op}`,
    profile: ctx.id,
    detail: { id, ...(sourceId ? { source_id: sourceId } : {}) },
  });
  return Response.json({ ok: true, output: result.output });
}

export async function handleContradictionAction(
  ctx: ApiContext,
  req: Request,
): Promise<Response> {
  const body = await readJsonBody(req);
  const op = body.op;
  const id = requirePattern(
    typeof body.id === "string" ? body.id : undefined,
    "id",
    ID_RE,
  );
  if (!ctx.cli) {
    return envelope(
      503,
      "E_UPSTREAM",
      "CLI channel unavailable on this host — use the copy-command instead",
    );
  }
  let result: { output: string };
  switch (op) {
    case "accept":
      result = await ctx.cli.decideProposalsAccept(id);
      break;
    case "reject":
      result = await ctx.cli.decideProposalsReject(id);
      break;
    case "undo":
      result = await ctx.cli.decideProposalsUndo(id);
      break;
    default:
      throw new BadRequestError("op must be accept|reject|undo");
  }
  ctx.mcp.invalidateAll();
  await auditWrite("owner", {
    action: `contradictions.${op}`,
    profile: ctx.id,
    detail: { id },
  });
  return Response.json({ ok: true, output: result.output });
}

export async function handleTakeResolve(
  ctx: ApiContext,
  req: Request,
): Promise<Response> {
  const body = await readJsonBody(req);
  const slug = requirePattern(
    typeof body.slug === "string" ? body.slug : undefined,
    "slug",
    SLUG_RE,
  );
  const row = Number(body.row);
  if (!Number.isInteger(row) || row < 1 || row > 10_000) {
    throw new BadRequestError("row must be an integer 1..10000");
  }
  const quality = body.quality;
  if (
    quality !== "correct" &&
    quality !== "incorrect" &&
    quality !== "partial" &&
    quality !== "unresolvable"
  ) {
    throw new BadRequestError("quality must be correct|incorrect|partial|unresolvable");
  }
  const result = await ctx.mcp.takesResolve(slug, row, quality);
  await auditWrite("owner", {
    action: "takes.resolve",
    profile: ctx.id,
    detail: { slug, row, quality },
  });
  return Response.json({ ok: true, result });
}

export async function handleResolveSlugs(
  ctx: ApiContext,
  url: URL,
): Promise<Response> {
  const partial = param(url, "partial");
  if (partial === undefined || partial.length < 1 || partial.length > 200) {
    throw new BadRequestError("partial is required (1..200 chars)");
  }
  const sourceId = requireSourceId(url);
  try {
    const slugs = await ctx.mcp.resolveSlugs(
      partial.replace(/[\x00-\x1f\x7f]/g, ""),
      sourceId,
    );
    return Response.json({
      status: "ok",
      slugs: Array.isArray(slugs) ? slugs.slice(0, 20) : [],
    });
  } catch (err) {
    return Response.json({
      status: reportStatus(err),
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export async function handleWriteCancel(
  ctx: ApiContext,
  req: Request,
): Promise<Response> {
  const body = await readJsonBody(req);
  const requestId = requirePattern(
    typeof body.request_id === "string" ? body.request_id : undefined,
    "request_id",
    REQUEST_ID_RE,
  );
  const receipt = await ctx.mcp.cancelWriteRequest(requestId);
  await auditWrite("owner", {
    action: "write.cancel",
    profile: ctx.id,
    detail: { request_id: requestId, status: receipt?.status },
  });
  return Response.json(receipt satisfies WriteReceipt);
}

export async function handleBrainHealth(ctx: ApiContext): Promise<Response> {
  try {
    const health = await ctx.mcp.brainHealth();
    const report: BrainHealthReport = {
      status: "ok",
      health,
      ...(ctx.mcp.lastNotices.length > 0
        ? { notices: [...ctx.mcp.lastNotices] }
        : {}),
    };
    return Response.json(report);
  } catch (err) {
    const report: BrainHealthReport = {
      status: reportStatus(err),
      error: err instanceof Error ? err.message : String(err),
    };
    return Response.json(report);
  }
}

export async function handleAnomalies(ctx: ApiContext): Promise<Response> {
  try {
    const items = await ctx.mcp.anomalies();
    const report: AnomaliesReport = { status: "ok", items };
    return Response.json(report);
  } catch (err) {
    const report: AnomaliesReport = {
      status: reportStatus(err),
      error: err instanceof Error ? err.message : String(err),
    };
    return Response.json(report);
  }
}

export async function handleAuditHistory(
  ctx: ApiContext,
  url: URL,
): Promise<Response> {
  const limitRaw = Number.parseInt(param(url, "limit") ?? "30", 10);
  const limit =
    Number.isInteger(limitRaw) && limitRaw > 0 && limitRaw <= 100 ? limitRaw : 30;
  const audit = await auditTail(limit);
  let decided: DecidedTakeRow[] | undefined;
  if (ctx.pg?.configured) {
    decided = await ctx.pg.decidedTakeProposals().catch(() => undefined);
  }
  const report: AuditHistoryReport = { audit, ...(decided ? { decided } : {}) };
  return Response.json(report);
}

export async function handleConfirm(
  ctx: ApiContext,
  req: Request,
): Promise<Response> {
  const body = await readJsonBody(req);
  const ref = requirePattern(
    typeof body.ref === "string" ? body.ref : undefined,
    "ref",
    /^(f|t)\d{1,18}$|^p:[a-zA-Z0-9][a-zA-Z0-9/_.-]{0,200}$/,
  );
  const result = await ctx.mcp.confirmMemory({ ref });
  ctx.mcp.invalidateAll();
  await auditWrite("owner", {
    action: "memory.confirm",
    profile: ctx.id,
    detail: { ref },
  });
  return Response.json({ ok: true, result });
}

// --- page write (receipt protocol) -------------------------------------------

export async function handlePageWrite(
  ctx: ApiContext,
  req: Request,
): Promise<Response> {
  const body = await readJsonBody(req);
  const slug = requirePattern(
    typeof body.slug === "string" ? body.slug : undefined,
    "slug",
    SLUG_RE,
  );
  if (typeof body.content !== "string" || body.content.length > 1_000_000) {
    throw new BadRequestError("content must be a string (≤1MB)");
  }
  // gbrain 0.60.x revisions are UUID strings (live-probed); accept both.
  const rawRevision = body.expected_revision;
  const expectedRevision =
    typeof rawRevision === "string" && /^[0-9a-fA-F-]{8,64}$/.test(rawRevision)
      ? rawRevision
      : typeof rawRevision === "number" &&
          Number.isInteger(rawRevision) &&
          rawRevision >= 0
        ? rawRevision
        : undefined;
  if (expectedRevision === undefined) {
    throw new BadRequestError(
      "expected_revision must be the page's current revision (string or integer)",
    );
  }
  // Client may pass its own request_id to make retries idempotent across
  // lost replies; otherwise we mint one. NEVER re-send with a new id.
  const requestId =
    typeof body.request_id === "string" && REQUEST_ID_RE.test(body.request_id)
      ? body.request_id
      : randomUUID();

  const receipt = await ctx.mcp.putPage({
    slug,
    content: body.content as string,
    expectedRevision,
    requestId,
  });
  if (receipt.status === "committed") ctx.mcp.invalidateAll();
  await auditWrite("owner", {
    action: "page.write",
    profile: ctx.id,
    detail: { slug, request_id: requestId, status: receipt.status },
  });
  return Response.json(receipt satisfies WriteReceipt);
}

export async function handleWriteRequest(
  ctx: ApiContext,
  url: URL,
): Promise<Response> {
  const requestId = requirePattern(
    param(url, "request_id"),
    "request_id",
    REQUEST_ID_RE,
  );
  const receipt = await ctx.mcp.getWriteRequest(requestId);
  if (receipt.status === "committed") ctx.mcp.invalidateAll();
  return Response.json(receipt satisfies WriteReceipt);
}
