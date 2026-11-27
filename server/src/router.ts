import { PROFILE_ID_RE, type ErrorCode } from "@gbrain-cockpit/shared";
import type { BrainChannels, BrainRegistry } from "./brains";
import type { Config } from "./config";
import type { InboxStateStore } from "./inbox-state";
import type { TokenVerifier } from "./auth";
import {
  authenticate,
  authorize,
  brainDenied,
  meResponse,
  OWNER_ADMIN,
  type Actor,
  type Denial,
  type PermClass,
} from "./authz";
import { API_HEADERS, envelope, withApiHeaders } from "./http";
import type { TokenRegistry } from "./tokens";
import {
  handleAnomalies,
  handleAskEvidence,
  handleAskMissing,
  handleAskThink,
  handleAuditHistory,
  handleBrainHealth,
  handleConfirm,
  handleContradictionAction,
  handleEdgeAction,
  handleEvidence,
  handleGraph,
  handleInbox,
  handleInboxRelief,
  handlePage,
  handlePageFacets,
  handlePageWrite,
  handlePages,
  handleProfiles,
  handleResolveSlugs,
  handleSearch,
  handleSources,
  handleSourcesStatus,
  handleOpsSourceDrift,
  handleOpsClients,
  handleOpsDreamRuns,
  handleOpsGrantRead,
  handleOpsNightly,
  handleOpsCalibration,
  handleOpsAssets,
  handleOpsDeploy,
  handleOpsModel,
  handleOpsModelTest,
  handleTakePropose,
  handleTakeResolve,
  handleTrustDrop,
  handleWriteCancel,
  handleWriteConflicts,
  handleWriteRequest,
  handleWriteRequests,
  type ApiContext,
} from "./routes/api";
import {
  handleTokenGrants,
  handleTokenIssue,
  handleTokenList,
  handleTokenRevoke,
} from "./routes/tokens";
import { getHealthReport } from "./routes/health";
import { mapError } from "./routes/api";

// The route table (0.7, ROADMAP-named-tokens §3.4). Every /api route is ONE
// row: method + path + its permission class + a binding. Dispatch only runs
// rows that are in this table, and no row's handler is reachable without
// passing the gate below — that is the structural half of "a named token
// cannot call a write route that nobody classified".
//
// The typing is the other half. `perm` is mandatory; its value is a closed
// union the authorizer exhaustively switches on; and a non-GET row may
// claim "view" only when its path is on POST_READ_PATHS (reads that take a
// body). Adding a class without a verdict, or a write route filed as a
// read, fails the build.

export interface RouteDeps {
  cfg: Config;
  verifier: TokenVerifier;
  registry: BrainRegistry;
  /** null = COCKPIT_TOKENS_FILE unset: named tokens are off */
  tokens: TokenRegistry | null;
  inboxStore: InboxStateStore | null;
}

export interface RequestScope {
  req: Request;
  url: URL;
  actor: Actor;
  /** this request's brain channels; null on the brain-less routes */
  ctx: ApiContext | null;
  deps: RouteDeps;
}

type HttpMethod = "GET" | "POST" | "PUT";
type WriteMethod = "POST" | "PUT";
type Run = (r: RequestScope) => Promise<Response>;

/** POST only because the call carries a body — the tool behind each is a
 *  read (evidence assembly, explain-target). Anything else that writes
 *  through POST must file under a write class. */
export const POST_READ_PATHS = ["/api/evidence", "/api/ask/missing"] as const;

export type RouteRow =
  | { method: "GET"; path: string; perm: "view"; run: Run }
  | {
      method: WriteMethod;
      path: (typeof POST_READ_PATHS)[number];
      perm: "view";
      run: Run;
    }
  | {
      method: HttpMethod;
      path: string;
      perm: Exclude<PermClass, "view">;
      run: Run;
    };

/** Routes that are not about any brain: no brain gate, `ctx` is null. */
const BRAINLESS = new Set([
  "GET /api/me",
  // a listing, not a brain call — and it must answer even when every brain
  // on the sheet is gone, so the UI can say so instead of failing to boot
  "GET /api/profiles",
  "GET /api/tokens",
  "POST /api/tokens",
  "PUT /api/tokens/grants",
  "POST /api/tokens/revoke",
]);

/** The owner's env tokens keep the in-handler tier check of 0.6 (grant-read,
 *  model probe); the bindings hand them the 0.6 Principal shape. */
function legacyPrincipal(actor: Actor): { name: string; tier: "base" | "admin" } {
  return { name: actor.name, tier: actor.tier ?? "base" };
}

function brain(r: RequestScope): ApiContext {
  if (r.ctx === null) throw new Error("route bound without a brain");
  return r.ctx;
}

function inbox(r: RequestScope): InboxStateStore | null {
  return r.deps.inboxStore;
}

export const ROUTES: readonly RouteRow[] = [
  // --- who am I / brain list ---------------------------------------------------
  {
    method: "GET",
    path: "/api/me",
    perm: "view",
    run: async (r) =>
      Response.json(
        meResponse(r.actor, {
          adminConfigured: r.deps.verifier.adminConfigured,
          brains: r.deps.registry.profileIds(),
          tokensWired: r.deps.tokens !== null,
        }),
      ),
  },
  {
    method: "GET",
    path: "/api/profiles",
    perm: "view",
    run: async (r) => {
      const res = await handleProfiles(
        r.deps.registry,
        r.deps.verifier.adminConfigured,
        r.actor,
      );
      return withApiHeaders(res);
    },
  },

  // --- reads ---------------------------------------------------------------------
  { method: "GET", path: "/api/graph", perm: "view", run: (r) => handleGraph(brain(r)) },
  { method: "GET", path: "/api/pages", perm: "view", run: (r) => handlePages(brain(r), r.url) },
  { method: "GET", path: "/api/pages/facets", perm: "view", run: (r) => handlePageFacets(brain(r), r.url) },
  {
    method: "GET",
    path: "/api/page",
    perm: "view",
    // a named token does not get the host-side file path of a page
    run: async (r) => {
      const res = await handlePage(brain(r), r.url);
      if (r.actor.kind === "env") return res;
      const body = (await res.json()) as { page?: Record<string, unknown> };
      if (body.page !== undefined) delete body.page.source_path;
      return Response.json(body);
    },
  },
  { method: "GET", path: "/api/search", perm: "view", run: (r) => handleSearch(brain(r), r.url) },
  { method: "GET", path: "/api/sources", perm: "view", run: (r) => handleSources(brain(r)) },
  { method: "GET", path: "/api/resolve-slugs", perm: "view", run: (r) => handleResolveSlugs(brain(r), r.url) },
  { method: "GET", path: "/api/ask", perm: "view", run: (r) => handleAskEvidence(brain(r), r.url) },
  {
    method: "GET",
    path: "/api/inbox",
    perm: "view",
    // named tokens: no command text, and without the adjudicate grant only
    // the edge-proposal queue (the graph draws "new relations" from it)
    run: async (r) => {
      const res = await handleInbox(brain(r), inbox(r));
      if (r.actor.kind === "env") return res;
      const report = (await res.json()) as Record<string, unknown>;
      return Response.json(trimInboxForToken(report, r.actor));
    },
  },
  {
    method: "GET",
    path: "/api/audit-history",
    perm: "view",
    run: (r) => handleAuditHistory(brain(r), r.url, r.actor),
  },
  { method: "POST", path: "/api/evidence", perm: "view", run: (r) => handleEvidence(brain(r), r.req) },
  { method: "POST", path: "/api/ask/missing", perm: "view", run: (r) => handleAskMissing(brain(r), r.req) },

  // --- adjudicate -----------------------------------------------------------------
  { method: "POST", path: "/api/inbox/trust/drop", perm: "adjudicate", run: (r) => handleTrustDrop(brain(r), r.req) },
  { method: "POST", path: "/api/inbox/edge", perm: "adjudicate", run: (r) => handleEdgeAction(brain(r), r.req) },
  { method: "POST", path: "/api/inbox/contradictions", perm: "adjudicate", run: (r) => handleContradictionAction(brain(r), r.req) },
  { method: "POST", path: "/api/inbox/takes/propose", perm: "adjudicate", run: (r) => handleTakePropose(brain(r), r.req) },
  { method: "POST", path: "/api/inbox/takes/resolve", perm: "adjudicate", run: (r) => handleTakeResolve(brain(r), r.req) },
  { method: "POST", path: "/api/inbox/relief", perm: "adjudicate", run: (r) => handleInboxRelief(brain(r), r.req, inbox(r)) },

  // --- edit (the per-source write channel opens in step 2) ------------------------
  { method: "PUT", path: "/api/page", perm: "edit", run: (r) => handlePageWrite(brain(r), r.req) },
  { method: "GET", path: "/api/write-request", perm: "edit", run: (r) => handleWriteRequest(brain(r), r.url) },

  // --- owner-only: ops, paid think, diagnostics, receipts, token management --------
  { method: "POST", path: "/api/ask/think", perm: "owner-only", run: (r) => handleAskThink(brain(r), r.req, legacyPrincipal(r.actor)) },
  { method: "POST", path: "/api/inbox/confirm", perm: "owner-only", run: (r) => handleConfirm(brain(r), r.req) },
  { method: "POST", path: "/api/write-cancel", perm: "owner-only", run: (r) => handleWriteCancel(brain(r), r.req) },
  { method: "GET", path: "/api/write-requests", perm: "owner-only", run: (r) => handleWriteRequests(brain(r), r.url) },
  { method: "GET", path: "/api/write-conflicts", perm: "owner-only", run: (r) => handleWriteConflicts(brain(r), r.url) },
  { method: "GET", path: "/api/healthz", perm: "owner-only", run: async (r) => Response.json(await getHealthReport(brain(r))) },
  { method: "GET", path: "/api/brain-health", perm: "owner-only", run: (r) => handleBrainHealth(brain(r)) },
  { method: "GET", path: "/api/sources/status", perm: "owner-only", run: (r) => handleSourcesStatus(brain(r)) },
  { method: "GET", path: "/api/anomalies", perm: "owner-only", run: (r) => handleAnomalies(brain(r)) },
  { method: "GET", path: "/api/ops/sources-drift", perm: "owner-only", run: (r) => handleOpsSourceDrift(brain(r)) },
  { method: "GET", path: "/api/ops/clients", perm: "owner-only", run: (r) => handleOpsClients(brain(r)) },
  { method: "GET", path: "/api/ops/dream-runs", perm: "owner-only", run: (r) => handleOpsDreamRuns(brain(r)) },
  { method: "GET", path: "/api/ops/nightly", perm: "owner-only", run: (r) => handleOpsNightly(brain(r)) },
  { method: "GET", path: "/api/ops/calibration", perm: "owner-only", run: (r) => handleOpsCalibration(brain(r)) },
  { method: "GET", path: "/api/ops/assets", perm: "owner-only", run: (r) => handleOpsAssets(brain(r)) },
  { method: "GET", path: "/api/ops/deploy", perm: "owner-only", run: (r) => handleOpsDeploy(brain(r)) },
  { method: "GET", path: "/api/ops/model", perm: "owner-only", run: (r) => handleOpsModel(brain(r)) },
  {
    method: "POST",
    path: "/api/ops/model/test",
    perm: "owner-only",
    run: (r) =>
      handleOpsModelTest(brain(r), legacyPrincipal(r.actor), r.deps.verifier.adminConfigured),
  },
  {
    method: "POST",
    path: "/api/ops/grant-read",
    perm: "owner-only",
    run: async (r) => {
      const res = await handleOpsGrantRead(
        brain(r),
        legacyPrincipal(r.actor),
        r.deps.verifier.adminConfigured,
      );
      // derived whoami hints may change with the widened grant
      r.deps.registry.invalidateProfileInfos();
      return res;
    },
  },
  { method: "GET", path: "/api/tokens", perm: "owner-only", run: (r) => handleTokenList(r.deps.tokens) },
  {
    method: "POST",
    path: "/api/tokens",
    perm: "owner-only",
    run: (r) => handleTokenIssue(r.deps.tokens, r.actor, r.req, r.deps.verifier.adminConfigured),
  },
  {
    method: "PUT",
    path: "/api/tokens/grants",
    perm: "owner-only",
    run: (r) => handleTokenGrants(r.deps.tokens, r.actor, r.req, r.deps.verifier.adminConfigured),
  },
  {
    method: "POST",
    path: "/api/tokens/revoke",
    perm: "owner-only",
    run: (r) => handleTokenRevoke(r.deps.tokens, r.actor, r.req, r.deps.verifier.adminConfigured),
  },
];

const TABLE = new Map<string, RouteRow>(
  ROUTES.map((row) => [`${row.method} ${row.path}`, row] as const),
);

/**
 * The whole /api dispatch: exact-match lookup → authenticate → brain gate
 * → permission class → handler. Returns the final Response; throws only
 * unexpectedly (the caller's catch-all maps those).
 */
export async function handleApi(
  req: Request,
  url: URL,
  deps: RouteDeps,
  table: Map<string, RouteRow> = TABLE,
): Promise<Response> {
  // Identity first, existence second: without a valid token a caller
  // learns nothing about the route table (the 0.6 switch behaved the same).
  const actor = authenticate(deps.verifier, deps.tokens, req.headers.get("authorization"));
  if (!actor) {
    return envelope(401, "E_UNAUTHENTICATED", "missing or invalid bearer token");
  }
  const key = `${req.method} ${url.pathname}`;
  const route = table.get(key);
  if (!route) return envelope(404, "E_NOT_FOUND", "unknown route");

  let ctx: ApiContext | null = null;
  if (!BRAINLESS.has(key)) {
    const header = req.headers.get("x-brain-profile");
    if (header !== null && !PROFILE_ID_RE.test(header)) {
      return envelope(400, "E_BAD_REQUEST", "invalid x-brain-profile header");
    }
    let channels: BrainChannels | null;
    if (actor.kind === "env") {
      // 0.6 behaviour exactly: absent header = the default profile, and an
      // unknown id is a 400, never a silent fallback to the wrong brain.
      channels = deps.registry.resolve(header);
      if (!channels) {
        return envelope(400, "E_BAD_REQUEST", `unknown brain profile: ${header}`);
      }
    } else {
      // A named token without a header goes to the FIRST brain on its sheet
      // (for curl and scripts). The browser always names the brain: the sheet
      // can change mid-session, and an implicit target would send a click to
      // a brain the user is not looking at. No fallback resolver here.
      const brainId = header ?? actor.brains?.[0] ?? "";
      const denied = brainDenied(actor, brainId, deps.registry.has(brainId));
      if (denied) return forbidden(denied);
      channels = deps.registry.resolveExact(brainId);
      if (!channels) return forbidden({ missing: "brain" });
    }
    ctx = { ...channels, actor };
  }

  // The class verdict runs before any handler code, so it also runs before
  // body validation: a wrongly-shaped body from an under-granted token is
  // a 403, never a 400.
  const denial = authorize(actor, route.perm);
  if (denial) return forbidden(denial);

  let res: Response;
  try {
    res = await route.run({ req, url, actor, ctx, deps });
  } catch (err) {
    // the owner keeps the upstream's own words (they act on them); a named
    // token gets the plain fact that the knowledge base did not answer
    if (actor.kind === "env") throw err;
    res = await tokenError(err);
  }
  // A named token's VIEW answers carry no terminal material and no host
  // detail: command-ish keys go, and a channel-down reason loses its paths.
  if (actor.kind === "token" && res.ok) res = await trimmedView(res);
  return withApiHeaders(res);
}

/** A failed call for a named token: same status and code, plain words. The
 *  caller's own mistakes (400/404) keep their message — it is about input. */
async function tokenError(err: unknown): Promise<Response> {
  const res = mapError(err);
  const code = (await res.clone().json() as { code?: ErrorCode }).code;
  const text = code === undefined ? undefined : PLAIN_UPSTREAM[code];
  if (code === undefined || text === undefined) return res;
  // the rebuilt envelope keeps the one header callers act on
  const retryAfter = res.headers.get("retry-after");
  return envelope(res.status, code, text, retryAfter ? { "retry-after": retryAfter } : {});
}

const PLAIN_UPSTREAM: Partial<Record<ErrorCode, string>> = {
  E_UPSTREAM: "the knowledge base could not answer this request right now — try again shortly",
  E_UPSTREAM_AUTH: "the knowledge base refused this request",
  E_RATE_LIMITED: "too many requests — try again shortly",
  E_INTERNAL: "unexpected server error",
};

/** Keys upstream has been seen to carry terminal material in (probed
 *  payloads): command lists, a single command, shorthand aliases. */
const COMMAND_KEYS = new Set(["commands", "command", "cmd", "cli", "docs_cmd"]);

async function trimmedView(res: Response): Promise<Response> {
  if (!(res.headers.get("content-type") ?? "").includes("application/json")) return res;
  return Response.json(scrubView(await res.json()));
}

function scrubView(value: unknown, depth = 0): unknown {
  if (depth > 32 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => scrubView(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    if (COMMAND_KEYS.has(key)) continue;
    // a "why this channel is down" line is upstream's first stderr line: it
    // may name host paths or internal addresses — keep the words, drop those
    out[key] =
      key === "error" && typeof inner === "string" ? redactHostDetails(inner) : scrubView(inner, depth + 1);
  }
  return out;
}

/**
 * Host detail inside a reason line becomes a placeholder: URLs and
 * connection strings, IP addresses (v4, bracketed v6, with or without a
 * port), and absolute or home-relative paths. The separator in front of a
 * path is kept (capturing group). Relative paths are left alone on purpose:
 * they are indistinguishable from page slugs, which are content.
 */
function redactHostDetails(text: string): string {
  return text
    .replace(/\b(?:https?|wss?|postgres(?:ql)?|file):\/\/[^\s"'`<>)\]]+/gi, "<address>")
    .replace(/\[[0-9A-Fa-f:.]+\](?::\d{1,5})?/g, "<address>")
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d{1,5})?\b/g, "<address>")
    .replace(
      /(^|[\s"'`(,=:;>\]}])((?:~|\.{1,2})?\/(?:[A-Za-z0-9_.@+-]+\/)*[A-Za-z0-9_.@+-]*)/g,
      "$1<path>",
    );
}

/** The rows as a lookup list (tests walk every one of them). */
export function routeKeys(): string[] {
  return [...TABLE.keys()];
}

export function routeFor(key: string): RouteRow | undefined {
  return TABLE.get(key);
}

function forbidden(denial: Denial): Response {
  const error =
    denial.missing === "adjudicate"
      ? "this action needs the adjudicate grant, which is not on this token's sheet"
      : denial.missing === "edit"
        ? denial.source !== undefined
          ? `this token may not edit source ${denial.source}`
          : "page writes need an edit grant, and no source is on this token's sheet"
        : denial.missing === "brain"
          ? "this token may not enter that brain profile"
          : "this action is reserved for the owner's env tokens";
  return envelope(403, "E_FORBIDDEN", error, {}, denial);
}

/**
 * What a named token gets from GET /api/inbox: the queues, minus everything
 * that is the owner's terminal material — command text, the CLI command
 * name, and the in-band "why this channel is down" strings (upstream's
 * first stderr line, which can name host paths). Without the adjudicate
 * grant it gets nothing but the edge-proposal queue the graph needs.
 */
export function trimInboxForToken(
  report: Record<string, unknown>,
  actor: Actor,
): Record<string, unknown> {
  if (actor.adjudicate !== true) {
    return { edgeProposals: scrub(report.edgeProposals) };
  }
  return scrub(report) as Record<string, unknown>;
}

// every key upstream has been seen to carry terminal material in
// (probed payloads): command lists, a single command, shorthand aliases
const OWNER_ONLY_FIELDS = new Set([...COMMAND_KEYS, "error"]);

function scrub(value: unknown, depth = 0): unknown {
  // JSON from upstream has no cycles; the bound only stops a hostile shape
  if (depth > 32 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => scrub(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    if (OWNER_ONLY_FIELDS.has(key)) continue;
    out[key] = scrub(inner, depth + 1);
  }
  return out;
}

