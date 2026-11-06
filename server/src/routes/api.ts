import { randomUUID } from "node:crypto";
import type {
  EdgeProposal,
  GraphReport,
  InboxReport,
  InboxQueue,
  PageDetail,
  PageSummary,
  PageVersion,
  PagesFacets,
  ProfilesResponse,
  SearchHit,
  SourcesReport,
  TakeProposal,
  TrustReviewEnvelope,
  TrustReviewItem,
  WriteReceipt,
} from "@gbrain-cockpit/shared";
import { isValidSourceId, TRUST_REF_RE } from "@gbrain-cockpit/shared";
import { auditWrite } from "../audit";
import type { BrainRegistry, BrainChannels } from "../brains";
import { BadRequestError, envelope, readJsonBody } from "../http";
import { CliExecutionError, CliValidationError } from "../drivers/cli";
import { McpError } from "../drivers/mcp";

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
  // keyset cursor (gbrain's own list_pages paging): both values come from a
  // previous response's last row and are regex-whitelisted before reuse
  const updatedAfter = param(url, "updated_after");
  if (updatedAfter !== undefined) {
    requirePattern(updatedAfter, "updated_after", TIMESTAMP_RE);
  }
  const updatedAfterSlug = param(url, "updated_after_slug");
  if (updatedAfterSlug !== undefined) {
    requirePattern(updatedAfterSlug, "updated_after_slug", SLUG_RE);
  }
  const sourceId = requireSourceId(url);
  const pages = await ctx.mcp.listPages({
    ...(type ? { type } : {}),
    limit,
    sort: "updated_desc",
    ...(updatedAfter ? { updatedAfter } : {}),
    ...(updatedAfterSlug ? { updatedAfterSlug } : {}),
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
  const [page, versions] = await Promise.all([
    ctx.mcp.getPage(slug, sourceId),
    ctx.mcp.versions(slug).catch(() => [] as PageVersion[]),
  ]);
  return Response.json({ page: page satisfies PageDetail, versions });
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
  const sourceId = requireSourceId(url);
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

// --- inbox ------------------------------------------------------------------

async function trustQueue(
  ctx: ApiContext,
): Promise<InboxQueue<TrustReviewItem>> {
  if (!ctx.cli) {
    return {
      status: "down",
      error: "CLI channel unavailable on this host — actions degrade to copy-command",
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
      error: "CLI channel unavailable on this host — actions degrade to copy-command",
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

async function takesQueue(
  ctx: ApiContext,
): Promise<InboxQueue<TakeProposal>> {
  // The pending-takes queue lives in gbrain's hidden CLI family
  // (`takes propose`), not behind an MCP tool — so this queue is CLI-only
  // by design and degrades to copy-command off the brain host.
  if (!ctx.cli) {
    return {
      status: "down",
      error: "CLI channel unavailable on this host — actions degrade to copy-command",
    };
  }
  try {
    const items = await ctx.cli.takesProposeList();
    return { status: "ok", items };
  } catch (err) {
    return {
      status: "down",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function handleInbox(ctx: ApiContext): Promise<Response> {
  const [trust, edgeProposals, takes] = await Promise.all([
    trustQueue(ctx),
    edgeQueue(ctx),
    takesQueue(ctx),
  ]);
  // The command name comes from the profile config (wrapper brains like
  // `gbrain-bip` exist); it is present even when the CLI driver itself is
  // down — copy-commands are the fallback, they must never go blank.
  const cliChannel = ctx.cli
    ? {
        ...(await ctx.cli.status()),
        command: ctx.profile.cliBin ?? "gbrain",
      }
    : {
        available: false,
        command: ctx.profile.cliBin ?? "gbrain",
        error: "gbrain binary not found",
      };
  const report: InboxReport = { trust, edgeProposals, takes, cliChannel };
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
  const result =
    op === "accept"
      ? await ctx.cli.takesProposeAccept(id)
      : await ctx.cli.takesProposeReject(id);
  ctx.mcp.invalidateAll();
  await auditWrite("owner", {
    action: `takes.propose.${op}`,
    profile: ctx.id,
    detail: { id },
  });
  return Response.json({ ok: true, output: result.output });
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
