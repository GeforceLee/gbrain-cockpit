// @gbrain-cockpit/shared — types shared by server and web.
//
// The adjudication channel matrix below is the code form of the design baseline
// (internal/ARCHITECTURE.md §4). Field corrections from live probing live in
// internal/GBRAIN-CAPABILITIES.md and win over this table; this constant is the
// single runtime source both packages compile against, so the two can never
// drift apart. The channel of an action is fixed by gbrain's own design and is
// NOT runtime-configurable (AGENTS.md non-negotiable #4).

/** Adjudication actions cockpit knows about. */
export type AdjudicationAction =
  | "trust.queue.list" // `gbrain trust review --json`
  | "trust.proposal.drop" // `gbrain trust drop <ref>` (tp/f/h)
  | "trust.proposal.accept" // accept a trust proposal — owner terminal only
  | "held-write.release" // release a held write — owner terminal only
  | "edge-proposals.list"
  | "edge-proposals.show"
  | "edge-proposals.accept"
  | "edge-proposals.reject"
  | "edge-proposals.date"
  | "edge-proposals.undo"
  // Contradiction proposals: gbrain's DEDICATED decide family (probed
  // 0.60.611: `decide proposals list/accept/reject/undo`). They also surface
  // as dp<id> entries inside `trust review`, but their disposition verbs are
  // these — NOT trust confirm/drop — so dp refs never enter TRUST_REF_RE.
  | "contradictions.queue.list" // `gbrain decide proposals list --json`
  | "contradictions.accept" // `gbrain decide proposals accept <id>`
  | "contradictions.reject" // `gbrain decide proposals reject <id>`
  | "contradictions.undo" // `gbrain decide proposals undo <id>`
  | "memory.confirm" // MCP confirm_memory (needs memory_confirm scope)
  // NOTE: no "takes.propose.list" here — the queue READ is not an
  // adjudication action; since 0.2.2 it rides the read-only bypass
  // (cross-source; the CLI verb single-source filters, GBRAIN-CAPABILITIES §2)
  | "takes.propose.accept" // `gbrain takes propose --accept <id>`
  | "takes.propose.reject" // `gbrain takes propose --reject <id>`
  | "takes.resolve" // MCP takes_resolve on ACTIVE takes (slug+row)
  | "page.write" // MCP put_page / edit_page (receipt protocol)
  | "write.cancel"; // MCP cancel_write_request (own token's, pre-publish)

/** The one and only channel an action may travel through. */
export type Channel = "mcp" | "cli-whitelist" | "copy-command";

/** cockpit's own version; shown in Health and sent as MCP clientInfo. */
export const COCKPIT_VERSION = "0.4.0";

export const ADJUDICATION_CHANNELS: Readonly<
  Record<AdjudicationAction, Channel>
> = {
  "trust.queue.list": "cli-whitelist",
  "trust.proposal.drop": "cli-whitelist",
  // gbrain gates these behind a typed-token terminal confirmation on purpose
  // (upstream ENG-15). cockpit prepares the command; the owner runs it. Never
  // programmatic confirmation, never batched.
  "trust.proposal.accept": "copy-command",
  "held-write.release": "copy-command",
  "edge-proposals.list": "cli-whitelist",
  "edge-proposals.show": "cli-whitelist",
  "edge-proposals.accept": "cli-whitelist",
  "edge-proposals.reject": "cli-whitelist",
  "edge-proposals.date": "cli-whitelist",
  "edge-proposals.undo": "cli-whitelist",
  // decide proposals carry no typed-token gate upstream (a --all-from batch
  // form exists, which a terminal-confirmation family never would) — same
  // adjudication class as edge-proposals: CLI whitelist, one-key, never the
  // owner-presence (copy-command) channel.
  "contradictions.queue.list": "cli-whitelist",
  "contradictions.accept": "cli-whitelist",
  "contradictions.reject": "cli-whitelist",
  "contradictions.undo": "cli-whitelist",
  "memory.confirm": "mcp",
  "takes.propose.accept": "cli-whitelist",
  "takes.propose.reject": "cli-whitelist",
  "takes.resolve": "mcp",
  "page.write": "mcp",
  // cancels only THIS token's accepted-but-unpublished writes — gbrain's own
  // guard, no owner-presence question (nothing has been published yet)
  "write.cancel": "mcp",
};

// --- Management (ops) channel matrix (0.4.0) ----------------------------------
// Route C (owner 2026-11-09): cockpit also manages brain-side operational
// state (source read grants, ops diagnostics). These are NOT adjudication
// actions — a second fixed matrix, same non-negotiables: each action has
// exactly one channel; copy-command is the operational DEGRADATION when the
// CLI channel is absent on this host (co-located deployments), never a
// runtime-configurable reroute. Trust-elevating verbs (trust accept, held
// writes) never appear here — they stay owner-terminal-only forever.

/** Management actions cockpit knows about (distinct from AdjudicationAction). */
export type ManagementAction =
  | "clients.list" // `gbrain auth clients --json` (owner-view grant registry)
  | "sources.list" // `gbrain sources list --json` (owner-view, carries archived)
  | "sources.grant-read" // `gbrain auth rescope --client <id> --federated-read <list>`
  | "doctor.cycle-freshness"; // `gbrain doctor --only cycle_freshness --json`

export const MANAGEMENT_CHANNELS: Readonly<
  Record<ManagementAction, Channel>
> = {
  "clients.list": "cli-whitelist",
  "sources.list": "cli-whitelist",
  "sources.grant-read": "cli-whitelist",
  "doctor.cycle-freshness": "cli-whitelist",
};

// --- Identities & profiles ---------------------------------------------------
// Multi-brain switching (P0) and the source axis (P1) both hinge on naming:
// which gbrain deployment a request targets, and which source within a brain
// a page belongs to. Page identity is (source_id, slug) upstream — slug is
// only unique per source (gbrain 0.60.558: pages UNIQUE (source_id, slug)) —
// so everything cross-referencing a page must carry the source too.

/**
 * Profile ids route the x-brain-profile header and key server-side caches.
 * Lowercase kebab, bounded: safe as map keys, log lines and audit fields.
 */
export const PROFILE_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

/**
 * Source ids as cockpit accepts them from HTTP (filters, get_page
 * disambiguation). `/` is forbidden on purpose: it would corrupt graph node
 * keys and MCP cache keys. Dunder-prefixed sentinels (`__all__` is
 * upstream's cross-source wildcard) are reserved and never selectable in
 * the UI — see isValidSourceId.
 */
export const SOURCE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * OAuth client ids gbrain mints (0.60.558 live-probed 2026-11-09):
 * `gbrain_cl_` + lowercase hex. Bounded loosely on the hex length so a
 * future format tweak still validates — the whitelist layer stays the gate.
 */
export const OWNER_CLIENT_ID_RE = /^gbrain_cl_[a-f0-9]{16,128}$/;

/**
 * The charset UPSTREAM's rescope accepts for a federated-read list entry
 * (core/source-id.ts SOURCE_ID_RE, probed 2026-11-09): 1-32 lowercase
 * alnum with interior hyphens only. Stricter than cockpit's own
 * SOURCE_ID_RE on purpose — values we SEND upstream must be shapes it
 * accepts, never shapes its assertValidSourceId would reject.
 */
export const GBRAIN_SOURCE_ID_RE = /^[a-z0-9]{1,32}(-[a-z0-9]{1,32})*$/;

/**
 * A comma-joined federated-read list as cockpit builds it for rescope
 * argv/copy-commands: upstream-shaped segments, ≤50 of them, ≤300 chars
 * total (the total bound is enforced by validateFederatedReadList, not
 * expressible in one regex).
 */
export const FEDERATED_LIST_RE =
  /^[a-z0-9]{1,32}(-[a-z0-9]{1,32})*(,[a-z0-9]{1,32}(-[a-z0-9]{1,32})*)*$/;

/** Validate + normalize a federated-read source list before it reaches argv. */
export function validateFederatedReadList(sources: string[]): string[] {
  const unique = [...new Set(sources)];
  if (unique.length === 0 || unique.length > 50) {
    throw new Error("federated-read list must carry 1..50 sources");
  }
  for (const s of unique) {
    if (!GBRAIN_SOURCE_ID_RE.test(s)) {
      throw new Error(`federated-read source rejected by upstream charset: ${s}`);
    }
  }
  const joined = unique.join(",");
  if (joined.length > 300) {
    throw new Error("federated-read list too long (>300 chars)");
  }
  if (!FEDERATED_LIST_RE.test(joined)) {
    throw new Error("federated-read list rejected by FEDERATED_LIST_RE");
  }
  return unique;
}

/** True when `v` is a selectable source id (charset + not a reserved sentinel). */
export function isValidSourceId(v: string): boolean {
  return SOURCE_ID_RE.test(v) && !v.startsWith("__");
}

/**
 * The CLI command a profile's owner runs on the brain host: either a bare
 * command name (resolved via PATH; no `/`, no whitespace, no leading dash)
 * or an absolute path. This string becomes argv[0] of execFile calls AND the
 * literal prefix of copy-command strings the owner pastes into a shell, so
 * the charset must be metachar-free by construction.
 */
export const OWNER_BIN_RE =
  /^(?:[a-z0-9][a-z0-9_-]{0,30}|\/[A-Za-z0-9._/-]{1,200})$/;

/** One gbrain deployment as configured server-side (secrets never leave). */
export interface BrainProfileConfig {
  id: string;
  name: string;
  /** MCP streamable-HTTP endpoint of this brain's serve. */
  mcpUrl: string;
  /** Static bearer token (legacy `gbrain auth create`) — XOR mcpCredentials. */
  mcpToken?: string;
  /**
   * Path to a gbrain OAuth client-credentials handoff file
   * (`gbrain mcp grant --credentials-out`, 0600) — XOR mcpToken. The driver
   * renews the access token itself; the secret never leaves the process.
   */
  mcpCredentials?: string;
  pgReadonlyDsn?: string;
  cliBin?: string;
  takesHolders?: string[];
  /**
   * Opt-in direct call to the REAL gbrain binary for source-scoped takes
   * adjudication (`takes propose --accept/--reject` resolve their source from
   * GBRAIN_SOURCE, which isolated-brain wrapper scripts unset by design).
   * Absolute path only; must be paired with gbrainHome and pgReadonlyDsn —
   * the driver re-checks `<gbrainHome>/.gbrain/config.json`'s database_url
   * basename against the DSN's database before every exec (the wrapper's own
   * safety assertion, replicated). Profiles file only, not legacy env.
   */
  gbrainBin?: string;
  /** The brain's GBRAIN_HOME — the directory holding `.gbrain/config.json`. */
  gbrainHome?: string;
}

/** The wire form of a profile: ids and labels only, zero secrets. */
export interface ProfileInfo {
  id: string;
  name: string;
  /** resolved CLI command name for owner copy-commands (default "gbrain") */
  cliCommand?: string;
  /** true when the profile's live whoami lacks the `write` scope (UX hint) */
  readOnly?: boolean;
  /**
   * true when the whoami scopes include `memory_confirm` (the one-key fact
   * confirm). Undefined = unknown (MCP unreachable) — never guessed.
   */
  canConfirm?: boolean;
}

export interface ProfilesResponse {
  defaultId: string;
  profiles: ProfileInfo[];
  /**
   * Whether this cockpit deployment has the management tier configured
   * (COCKPIT_ADMIN_TOKEN set) — a DEPLOYMENT capability, not a browser
   * state: the Admin panel is visible to any base-token session on a
   * two-tier install (management reads ride the base token; only the
   * grant write asks for the admin token at step-up). Absent/false ⇒ the
   * sixth panel never renders; single-token installs see zero change.
   */
  adminTier?: boolean;
}

// --- Owner copy-commands -----------------------------------------------------
// The single source of the command strings the Inbox renders for the owner
// to paste into a terminal on the brain host (channel: copy-command, AGENTS
// non-negotiable #1/#4). `bin` is the profile's resolved command name; with
// a custom wrapper (e.g. `gbrain-bip`) the self-built template is the ONLY
// trustworthy text — upstream's literal `gbrain …` command strings would
// target the default brain (wrong-brain mutation), so they are gated out.

function assertOwnerBin(bin: string): void {
  if (!OWNER_BIN_RE.test(bin)) {
    throw new Error(`owner command bin rejected by OWNER_BIN_RE: ${bin}`);
  }
}

function assertTrustRef(ref: string): void {
  if (!TRUST_REF_RE.test(ref)) {
    throw new Error(`owner command ref rejected by TRUST_REF_RE: ${ref}`);
  }
}

function assertCliId(id: string): void {
  if (!/^\d{1,18}$/.test(id)) {
    throw new Error(`owner command id rejected: ${id}`);
  }
}

export function trustConfirmCommand(bin: string, ref: string): string {
  assertOwnerBin(bin);
  assertTrustRef(ref);
  return `${bin} trust confirm ${ref}`;
}

export function trustReleaseCommand(bin: string, ref: string): string {
  assertOwnerBin(bin);
  assertTrustRef(ref);
  return `${bin} trust release ${ref}`;
}

export function trustDropCommand(bin: string, ref: string): string {
  assertOwnerBin(bin);
  assertTrustRef(ref);
  return `${bin} trust drop ${ref}`;
}

export function trustExplainCommand(bin: string, ref: string): string {
  assertOwnerBin(bin);
  assertTrustRef(ref);
  return `${bin} trust explain ${ref}`;
}

export function edgeAcceptCommand(bin: string, id: string): string {
  assertOwnerBin(bin);
  assertCliId(id);
  return `${bin} edge-proposals accept ${id}`;
}

export function contradictionAcceptCommand(bin: string, id: string): string {
  assertOwnerBin(bin);
  assertCliId(id);
  return `${bin} decide proposals accept ${id}`;
}

export function contradictionRejectCommand(bin: string, id: string): string {
  assertOwnerBin(bin);
  assertCliId(id);
  return `${bin} decide proposals reject ${id}`;
}

/**
 * The rescope copy-command for the sources-grant fallback rail. REPLACE
 * semantics upstream: the list is the client's whole federated_read, so
 * callers must pass current ∪ additions — never just the additions.
 */
export function authRescopeCommand(
  bin: string,
  clientId: string,
  sources: string[],
): string {
  assertOwnerBin(bin);
  if (!OWNER_CLIENT_ID_RE.test(clientId)) {
    throw new Error(`owner command client id rejected by OWNER_CLIENT_ID_RE: ${clientId}`);
  }
  const list = validateFederatedReadList(sources).join(",");
  return `${bin} auth rescope --client ${clientId} --federated-read ${list}`;
}

/**
 * The revoke copy-command — owner-terminal ONLY by design (upstream
 * hard-deletes the client and cascades to its tokens+codes; the same
 * owner-presence class as trust verbs). Never a whitelist verb, never a
 * one-key route, never in MANAGEMENT_CHANNELS. Shape pinned by probe:
 * `auth revoke-client <client_id>` (positional; 0.60.558, 2026-11-09).
 */
export function authRevokeClientCommand(bin: string, clientId: string): string {
  assertOwnerBin(bin);
  if (!OWNER_CLIENT_ID_RE.test(clientId)) {
    throw new Error(`owner command client id rejected by OWNER_CLIENT_ID_RE: ${clientId}`);
  }
  return `${bin} auth revoke-client ${clientId}`;
}

/**
 * The human-view registry read for the CLI-down degradation hint — plain
 * `auth clients`, NOT the --json form (the owner pasting this wants the
 * readable table, not raw JSON; --json stays on the whitelist verb).
 */
export function authClientsListCommand(bin: string): string {
  assertOwnerBin(bin);
  return `${bin} auth clients`;
}

/**
 * The unique graph node id for a page: `sourceId/slug` when the source is
 * known (source ids never contain `/` — SOURCE_ID_RE), bare `slug` in the
 * degraded no-source-column mode. Consumers that need (slug, source_id)
 * back must read them from the node's own fields, never re-parse the key:
 * slugs may themselves contain `/` (e.g. `kb/migration0007`), so a key is
 * only splittable when its format is known.
 */
export function buildGraphKey(
  sourceId: string | undefined,
  slug: string,
): string {
  return sourceId ? `${sourceId}/${slug}` : slug;
}

// --- Error envelopes -------------------------------------------------------
// The browser only ever sees `{ error, summary, code }`; anything richer
// (stderr, paths, DSNs) stays in server-side logs (ARCHITECTURE §5-7).

export const ERROR_CODES = [
  "E_BAD_REQUEST",
  "E_UNAUTHENTICATED",
  "E_FORBIDDEN",
  "E_NOT_FOUND",
  "E_METHOD_NOT_ALLOWED",
  "E_UPSTREAM",
  "E_UPSTREAM_AUTH",
  "E_RATE_LIMITED",
  "E_INTERNAL",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ErrorEnvelope {
  error: string;
  code: ErrorCode;
}

// --- Health report ---------------------------------------------------------
// Produced by the server for /healthz (coarse) and /api/healthz (full);
// consumed by the web Health panel. Statuses double as the traffic-light
// vocabulary everywhere: ok / degraded / down.

export type CheckStatus = "ok" | "degraded" | "down";

export interface McpWhoami {
  transport?: string;
  client?: string;
  scopes?: string[];
  /**
   * gbrain 0.60.558 whoami differs per transport: legacy bearers return
   * token_name + top-level scopes; OAuth grants return client_id/client_name
   * with scopes (and source_id/federated_read) inside a capabilities spread.
   * The server normalizes `client`/`scopes` from whichever shape arrives.
   */
  [k: string]: unknown;
}

export interface BrainIdentity {
  name?: string;
  version?: string;
  engine?: string;
  counts?: Record<string, number>;
  [k: string]: unknown;
}

export interface McpCheck {
  status: CheckStatus;
  latencyMs?: number;
  whoami?: McpWhoami;
  error?: string;
}

export interface CliCheck {
  status: CheckStatus;
  /** null = not found on this host */
  bin?: string | null;
  /** machine-readable reason for the status */
  reason?:
    | "binary-verified"
    | "binary-found-unverified"
    | "binary-not-found"
    | "not-configured-host";
  error?: string;
}

export interface BrainCheck {
  status: CheckStatus;
  identity?: BrainIdentity;
  error?: string;
}

export interface PgCheck {
  status: CheckStatus;
  latencyMs?: number;
  error?: string;
}

export interface HealthReport {
  status: CheckStatus;
  cockpitVersion: string;
  uptimeMs: number;
  generatedAt: string;
  /** which brain deployment this report describes (multi-profile) */
  profile?: {
    id: string;
    name: string;
  };
  checks: {
    mcp: McpCheck;
    brain: BrainCheck;
    cli: CliCheck;
    /** read-only graph bypass — present only when PG_READONLY_DSN is set */
    pg?: PgCheck;
  };
}

export function worstStatus(...statuses: CheckStatus[]): CheckStatus {
  if (statuses.includes("down")) return "down";
  if (statuses.includes("degraded")) return "degraded";
  return "ok";
}

// --- Read surface (core-loop milestone) ------------------------------------
// gbrain 0.60.558 shapes, recorded from live probes 2026-11-04. All types
// carry an index signature: fields we don't model pass through instead of
// being dropped, and the UI renders known fields defensively.

export interface PageSummary {
  slug: string;
  source_id?: string;
  type?: string;
  title?: string;
  updated_at?: string;
  [k: string]: unknown;
}

export interface FacetTypeCount {
  type: string;
  count: number;
}

export interface PagesFacets {
  pack_identity?: string;
  total_pages?: number;
  by_type: FacetTypeCount[];
  /**
   * Which set the numbers describe (0.4.0 hotfix): "source" = narrowed to
   * source_id via the read-only bypass; "source-degraded" = a source was
   * asked but the bypass is down, so the numbers span ALL sources and the UI
   * must say so; absent = the plain brain-wide form.
   */
  scope?: "source" | "source-degraded";
  source_id?: string;
  [k: string]: unknown;
}

export interface PageDetail {
  slug: string;
  /** identity is (source_id, slug) — slug alone is ambiguous across sources */
  source_id?: string;
  /** gbrain 0.60.x hands out UUID strings here; numeric for safety */
  revision?: number | string;
  content?: string;
  title?: string;
  type?: string;
  tags?: string[];
  trust_tier?: string;
  origin?: string;
  quoted?: string;
  created_at?: string;
  updated_at?: string;
  compiled_truth?: string;
  [k: string]: unknown;
}

export interface PageVersion {
  id?: number | string;
  snapshot_at?: string;
  title?: string;
  type?: string;
  [k: string]: unknown;
}

export interface SearchHit {
  slug?: string;
  title?: string;
  type?: string;
  chunk_text?: string;
  score?: number;
  trust_tier?: string;
  source_id?: string;
  [k: string]: unknown;
}

/** One row of MCP `sources_list` (grant-scoped upstream, no withheld marker). */
export interface SourceSummary {
  id: string;
  name?: string;
  page_count?: number;
  remote_url?: string | null;
  [k: string]: unknown;
}

/** GET /api/sources — in-band degraded like every other channel report. */
export interface SourcesReport {
  status: CheckStatus;
  items?: SourceSummary[];
  error?: string;
}

// --- V1.1 dimensions & provenance (gbrain 0.60.558, live-probed 2026-11-06) --
// Probe snapshots: internal/probes/mcp-probe-v1.1*.json (read-only tools only).

/**
 * One edge row from MCP get_links / get_backlinks: a flat record carrying the
 * FULL identity of both endpoints (from_* = referrer, to_* = target), an
 * excerpt of the linking context, and the edge's provenance — link_source is
 * where the edge came from (markdown, mcp-remote-mention, manual…), origin_*
 * names the page/field it was extracted from when applicable. The same
 * from→to pair may appear once per provenance; that is the data, not a bug.
 */
export interface LinkRow {
  from_slug?: string;
  from_source_id?: string;
  to_slug?: string;
  to_source_id?: string;
  link_type?: string;
  context?: string;
  link_source?: string;
  origin_slug?: string | null;
  origin_source_id?: string | null;
  origin_field?: string | null;
  [k: string]: unknown;
}

/**
 * One read-only timeline entry (MCP get_timeline). The probed brain's pages
 * carry none yet (all calls returned []), so only the two documented fields
 * are modeled — everything else passes through and renders defensively.
 */
export interface TimelineEntry {
  date?: string;
  text?: string;
  [k: string]: unknown;
}

/**
 * One receipt row from MCP list_write_requests (`{requests, next}` envelope,
 * probed empty on 0.60.558). Status uses the write-receipt vocabulary; an
 * unknown upstream value still renders (defensive chip).
 */
export interface WriteRequestRow {
  request_id?: string;
  slug?: string;
  status?: WriteStatus;
  created_at?: string;
  [k: string]: unknown;
}

/** GET /api/write-requests — the token's own receipts, newest first (in-band). */
export interface WriteRequestsReport {
  status: CheckStatus;
  items?: WriteRequestRow[];
  error?: string;
}

/** One slug group from MCP list_write_conflicts (repeated source_changed). */
export interface WriteConflictRow {
  slug?: string;
  source_id?: string;
  [k: string]: unknown;
}

/** GET /api/write-conflicts — in-band like every other channel report. */
export interface WriteConflictsReport {
  status: CheckStatus;
  items?: WriteConflictRow[];
  error?: string;
}

/**
 * One per-source diagnostic from MCP sources_status. NOTE: upstream's argument
 * is `id` (not source_id — probed). clone_state vocabulary per description:
 * healthy | missing | not-a-dir | no-git | url-drift | corrupted |
 * not-applicable; unknown values render with the neutral fallback.
 */
export interface SourceDiagnostic {
  id: string;
  clone_state?: string;
  last_sync_at?: string;
  [k: string]: unknown;
}

/** GET /api/sources/status — per-source diagnostics, in-band degraded. */
export interface SourcesStatusReport {
  status: CheckStatus;
  items?: SourceDiagnostic[];
  error?: string;
}

/** One assembled evidence unit (MCP assemble_evidence results[] row). */
export interface EvidenceRow {
  slug?: string;
  source_id?: string;
  title?: string;
  chunk_text?: string;
  chunk_id?: number;
  [k: string]: unknown;
}

/** What MCP assemble_evidence answers (results + unresolved passthrough). */
export interface EvidencePayload {
  results?: EvidenceRow[];
  unresolved?: unknown[];
  [k: string]: unknown;
}

/** POST /api/evidence — in-band report over assemble_evidence. */
export interface EvidenceReport {
  status: CheckStatus;
  results?: EvidenceRow[];
  unresolved?: unknown[];
  error?: string;
}

// --- Inbox ------------------------------------------------------------------
// Trust refs: tp<id> proposal, h<id> held write, f<id> standing preference /
// fact candidate, a<id> allow rule, t<id> take (see `gbrain trust --help`).
// review items carry their exact commands — prefer gbrain's own command text
// over anything cockpit builds (narrow adaptation surface).

/**
 * The one trust-ref pattern, shared by the server's route validation and the
 * web client's copy-command builder, so the two can never drift apart.
 */
export const TRUST_REF_RE = /^(tp|h|f|a|t)\d{1,18}$/;

export type TrustRefPrefix = "tp" | "h" | "f" | "a" | "t";

export interface TrustReviewItem {
  ref?: string;
  kind?: string;
  /** gbrain's ready-to-run commands for this item, when provided */
  commands?: unknown;
  [k: string]: unknown;
}

export interface TrustReviewEnvelope {
  schema_version?: number;
  items?: TrustReviewItem[];
  groups?: unknown[];
  counts?: Record<string, number>;
  [k: string]: unknown;
}

export interface EdgeProposal {
  id?: string | number;
  [k: string]: unknown;
}

/**
 * One contradiction proposal from `gbrain decide proposals list --json`
 * (probed empty on 0.60.611: `{status, proposals: [], review_proposals: []}`
 * — row shape still unknown, so everything beyond id is defensive
 * passthrough; the UI renders known-looking fields and never assumes).
 */
export interface ContradictionProposal {
  id?: string | number;
  [k: string]: unknown;
}

/**
 * The Inbox's fifth queue: contradiction proposals from the decide family,
 * plus the state of the `eval suspected-contradictions` probe that feeds
 * `find_contradictions` (the lane's informational header). The probe state
 * distinguishes "never ran" (note present — the empty state says HOW to run
 * it, never "no contradictions") from "ran, found nothing".
 */
export interface ContradictionsReport extends InboxQueue<ContradictionProposal> {
  probe?: {
    ranAt?: string;
    runId?: string;
    /** upstream's own self-describing line when no probe has ever run */
    note?: string;
    totalVisible?: number;
  };
}

/** GET-level read of MCP find_contradictions — the probe-state half of the lane. */
export interface ContradictionProbeState {
  ranAt?: string;
  runId?: string;
  note?: string;
  totalVisible?: number;
  [k: string]: unknown;
}

export interface TakeItem {
  ref?: string;
  id?: string | number;
  claim?: string;
  holder?: string;
  kind?: string;
  active?: boolean;
  [k: string]: unknown;
}

/**
 * One pending LLM-proposed take (`gbrain takes propose --json`, verified on
 * 0.60.558). This — NOT MCP takes_list (active takes only) — is the real
 * source of the Inbox "takes to resolve" queue.
 */
export interface TakeProposal {
  id: number;
  source_id?: string;
  page_slug: string;
  claim_text: string;
  kind?: string; // take | hunch | fact | bet
  holder?: string;
  weight?: number;
  domain?: string;
  status?: string;
  proposed_at?: string;
  model_id?: string;
  promoted_row_num?: number | null;
  [k: string]: unknown;
}

export interface InboxQueue<T> {
  status: CheckStatus;
  items?: T[];
  counts?: Record<string, number>;
  error?: string;
}

/**
 * Server-built copy-command templates for the takes queue's degraded rail
 * (CLI channel down). One pair per SOURCE — the only per-row variable besides
 * the id — carrying a literal `{id}` placeholder the client substitutes after
 * its own digits-only validation. Scoped entries are the direct-call form
 * (GBRAIN_SOURCE + GBRAIN_HOME + the REAL binary), identical in shape to the
 * one-key path's guard exec; plain wrapper-form entries exist only for rows
 * in the default source, where gbrain's source resolver lands anyway.
 */
export interface TakeCommandPair {
  accept: string;
  reject: string;
}

export interface TakeQueueCommands {
  /** keyed by source_id; rows without one land under "default" */
  bySource: Record<string, TakeCommandPair>;
  /** sources no trustworthy command could be built for (no direct-call pair
   *  and not the default source) — the UI explains instead of pasting a
   *  command known to fail (the 0.2.2 multi-source bug, degraded form) */
  unavailable: string[];
}

/** The pending-takes queue, plus its degraded-rail command templates. */
export interface TakesQueue extends InboxQueue<TakeProposal> {
  commands?: TakeQueueCommands;
  /**
   * Companion read-only view: pages whose extraction keeps failing and got
   * held (`takes propose --failed --json`, CLI whitelist). Release
   * (--retry-failed) stays an owner action — cockpit only surfaces them.
   */
  failed?: {
    status: CheckStatus;
    items?: Array<{ slug?: string; source_id?: string; [k: string]: unknown }>;
    error?: string;
  };
}

/** One auto-extracted entity stub awaiting owner review (extraction_pending). */
export interface ExtractionStub {
  slug?: string;
  [k: string]: unknown;
}

/**
 * The entity-stub queue: read-only (the dispose verb extraction_review is
 * owner-only upstream — not on cockpit's token face, no CLI form), so the
 * lane shows the pending list plus the other two lists' counts.
 */
export interface ExtractionQueue extends InboxQueue<ExtractionStub> {
  unattributedCount?: number;
  duplicatesCount?: number;
}

export interface InboxReport {
  trust: InboxQueue<TrustReviewItem>;
  edgeProposals: InboxQueue<EdgeProposal>;
  takes: TakesQueue;
  contradictions: ContradictionsReport;
  /** auto-extracted entity stubs (read-only lane) */
  extraction: ExtractionQueue;
  /** ACTIVE takes awaiting judgment (takes_list → takes_resolve closes the loop) */
  activeTakes: InboxQueue<TakeItem>;
  cliChannel: CliChannelStatus;
}

/** GET /api/brain-health — get_brain_health + the driver's latest _meta notices. */
export interface BrainHealthReport {
  status: CheckStatus;
  health?: Record<string, unknown>;
  /** latest upstream behavior-disclosure notices (text, capped) */
  notices?: string[];
  error?: string;
}

/**
 * One find_anomalies cohort row (fields as probed 0.60.558/0.60.611). When
 * `baseline_stddev` is 0 the cohort has NO baseline yet (e.g. a type that
 * appeared with a bulk ingest) — sigma_observed degenerates to the raw
 * count and must be DISPLAYED as "new cohort, no baseline", never as a
 * sigma number. All fields optional: upstream shape wins, defensive reads.
 */
export interface AnomalyCohort {
  cohort_kind?: string;
  cohort_value?: string;
  count?: number;
  baseline_mean?: number;
  baseline_stddev?: number;
  sigma_observed?: number;
  page_slugs?: string[];
  page_slugs_complete?: boolean;
  [k: string]: unknown;
}

/** GET /api/anomalies — find_anomalies, in-band. */
export interface AnomaliesReport {
  status: CheckStatus;
  items?: AnomalyCohort[];
  error?: string;
}

/** GET /api/audit-history — tail of the server-side JSONL audit trail. */
export interface AuditHistoryRow {
  at?: string;
  actor?: string;
  action?: string;
  profile?: string;
  detail?: Record<string, unknown>;
  [k: string]: unknown;
}

/** GET /api/audit-history — the verdict history's two server sides. */
export interface AuditHistoryReport {
  audit: AuditHistoryRow[];
  /** decided take_proposals rows; absent when the bypass is down */
  decided?: DecidedTakeRow[];
}

/** One decided take_proposals row (the pg side of the verdict history). */
export interface DecidedTakeRow {
  id: number;
  status?: string;
  acted_at?: string;
  acted_by?: string;
  page_slug: string;
  claim_text: string;
  source_id?: string;
  [k: string]: unknown;
}

export type TakeQuality = "correct" | "incorrect" | "partial" | "unresolvable";

// --- CLI channel ------------------------------------------------------------

export interface CliChannelStatus {
  available: boolean;
  /**
   * Why the channel is (un)available — same vocabulary as the Health
   * panel's CLI card (CliCheck.reason), so the Inbox chip and Health can
   * never tell two different stories about one probe.
   */
  reason?: CliCheck["reason"];
  /** "unprobed" until first use; result cached briefly */
  probedAt?: string;
  /**
   * The profile's resolved CLI command name for owner copy-commands
   * ("gbrain" when unset). Present even when the driver itself is down —
   * copy-commands are the fallback, they must never go blank.
   */
  command?: string;
  error?: string;
}

// --- 0.4.0 management (ops) reports -------------------------------------------
// The ops routes ride the same in-band degradation vocabulary as every other
// channel report. Management WRITES additionally require the admin tier
// (COCKPIT_ADMIN_TOKEN, D6 amendment 2026-11-09); management reads ride the
// base token — they are diagnostics, not actions.

/** The slice of an `auth clients --json` row cockpit consumes. */
export interface OpsClientGrant {
  client_id: string;
  client_name?: string;
  scopes?: string;
  federated_read?: string[];
  [k: string]: unknown;
}

/** pg-side source presence (pages grouped by source; the bypass's own view). */
export interface OpsSourcePages {
  source_id: string;
  pages: number;
}

/**
 * GET /api/ops/sources-drift — the pg bypass sees the whole database, MCP
 * sources_list only sees granted sources; the delta is pages that exist but
 * the browser can never read. `missing` = has pages AND active AND not
 * granted (archived/removed sources are never flagged — re-granting one
 * would brick the client's token issuance, upstream rescope does not check).
 */
export interface OpsSourceDriftReport {
  status: CheckStatus;
  pgSources?: OpsSourcePages[];
  /** active (non-archived) source ids, CLI owner view; absent when CLI down */
  activeSources?: string[];
  /** cockpit's own client's current federated_read; absent when unknowable */
  grantedSources?: string[];
  missing?: string[];
  action: {
    available: boolean;
    reason?:
      | "cli-unavailable"
      | "not-oauth-profile"
      | "pg-unavailable"
      | "admin-token-unconfigured";
    /** server-built copy-command fallback; present whenever one-key is not */
    command?: string;
  };
  error?: string;
}

/** One dream proposal run (take_proposals grouped by proposal_run_id). */
export interface OpsDreamRun {
  runId: string;
  start: string;
  end: string;
  takes: number;
  pending: number;
}

/**
 * GET /api/ops/dream-runs — proposal ACTIVITY, not dream liveness: a healthy
 * mature brain can run dream nightly and propose zero takes, so the card's
 * claim is "last proposal activity" and the upstream cycle_freshness verdict
 * (doctor's own band, message shown verbatim — never parsed) carries the
 * "is the pipeline running" half.
 */
export interface OpsDreamRunsReport {
  status: CheckStatus;
  runs?: OpsDreamRun[];
  /** ISO of the newest run_end; absent when take_proposals is empty */
  lastActivityAt?: string;
  neverRan: boolean;
  pendingTotal?: number;
  cycleFreshness?: {
    status: "ok" | "warn" | "fail" | "unknown";
    message?: string;
  };
  error?: string;
}

/** POST /api/ops/grant-read — always a pure union, never revokes. */
export interface OpsGrantReadResult {
  status: "ok";
  /** sources added by THIS call; empty = idempotent no-op (already granted) */
  added: string[];
  federatedRead: string[];
}

/**
 * GET /api/ops/clients — the OAuth client registry (`auth clients --json`,
 * owner view via the CLI whitelist). Base token: a read. `selfClientId`
 * names cockpit's own row (from the profile's credentials file); absent on
 * legacy-token profiles. Revoked rows are surfaced as `revoked: true` —
 * the UI badges them instead of offering actions.
 */
export interface OpsClientsReport {
  status: CheckStatus;
  clients?: OpsClientGrant[];
  selfClientId?: string;
  /** human-view read command for the CLI-down degradation hint */
  command?: string;
  error?: string;
}

// --- Graph (read-only bypass) -------------------------------------------------
// ARCHITECTURE §3.3, channel ③: a fixed read-only SELECT over the pages and
// links tables — the ONLY data source for the Nebula whole-brain map. Zero
// user input ever reaches SQL. PGLite engines simply leave PG_READONLY_DSN
// unset; the channel then reports "down" and degrades, never crashes.

export interface GraphNode {
  /**
   * Unique node id: `source_id/slug` when the source column is present,
   * bare slug in the degraded mode (see buildGraphKey). Slugs may repeat
   * across nodes — `slug` below is the display label, NOT the identity.
   */
  key: string;
  slug: string;
  source_id?: string;
  title?: string;
  type?: string;
  updated_at?: string;
  degree: number;
  [k: string]: unknown;
}

export interface GraphEdge {
  /** source page key (GraphNode.key) */
  source: string;
  /** target page key (GraphNode.key) */
  target: string;
  link_type?: string;
  link_source?: string;
  [k: string]: unknown;
}

export interface GraphReport {
  status: CheckStatus;
  /**
   * Changes whenever the underlying pages/links change. Clients freeze FA2
   * layout coordinates per (profile, fingerprint) pair so dream diffs stay
   * comparable while two brains with coincidentally identical fingerprints
   * never share a frozen layout (layout coordinates frozen — style-review
   * hard constraint).
   */
  fingerprint?: string;
  /** true when serving the cached graph after a probe/refetch failure */
  stale?: boolean;
  generatedAt?: string;
  error?: string;
  nodes?: GraphNode[];
  edges?: GraphEdge[];
  [k: string]: unknown;
}

// --- Write receipts ----------------------------------------------------------
// gbrain write states: queued → running → committed | conflict | failed |
// cancelled. "pending" = wait_ms elapsed without a final receipt; poll
// get_write_request with the SAME request_id, never re-send (ARCHITECTURE §3.1).

export type WriteStatus =
  | "queued"
  | "running"
  | "pending"
  | "committed"
  | "conflict"
  | "failed"
  | "cancelled"
  | "unknown";

export interface WriteReceipt {
  request_id: string;
  status: WriteStatus;
  detail?: string;
  [k: string]: unknown;
}
