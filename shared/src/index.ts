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
  | "memory.confirm" // MCP confirm_memory (needs memory_confirm scope)
  | "takes.propose.list" // `gbrain takes propose --json` (hidden family)
  | "takes.propose.accept" // `gbrain takes propose --accept <id>`
  | "takes.propose.reject" // `gbrain takes propose --reject <id>`
  | "takes.resolve" // MCP takes_resolve on ACTIVE takes (slug+row, future)
  | "page.write"; // MCP put_page / edit_page (receipt protocol)

/** The one and only channel an action may travel through. */
export type Channel = "mcp" | "cli-whitelist" | "copy-command";

/** cockpit's own version; shown in Health and sent as MCP clientInfo. */
export const COCKPIT_VERSION = "0.1.1";

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
  "memory.confirm": "mcp",
  "takes.propose.list": "cli-whitelist",
  "takes.propose.accept": "cli-whitelist",
  "takes.propose.reject": "cli-whitelist",
  "takes.resolve": "mcp",
  "page.write": "mcp",
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

export function takesAcceptCommand(bin: string, id: string): string {
  assertOwnerBin(bin);
  assertCliId(id);
  return `${bin} takes propose --accept ${id}`;
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

export interface InboxReport {
  trust: InboxQueue<TrustReviewItem>;
  edgeProposals: InboxQueue<EdgeProposal>;
  takes: InboxQueue<TakeProposal>;
  cliChannel: CliChannelStatus;
}

export type TakeQuality = "correct" | "incorrect" | "partial" | "unresolvable";

// --- CLI channel ------------------------------------------------------------

export interface CliChannelStatus {
  available: boolean;
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
