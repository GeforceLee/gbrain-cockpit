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
export const COCKPIT_VERSION = "0.1.0";

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

// --- Error envelopes -------------------------------------------------------
// The browser only ever sees `{ error: summary, code }`; anything richer
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
  error?: string;
}

// --- Graph (read-only bypass) -------------------------------------------------
// ARCHITECTURE §3.3, channel ③: a fixed read-only SELECT over the pages and
// links tables — the ONLY data source for the Nebula whole-brain map. Zero
// user input ever reaches SQL. PGLite engines simply leave PG_READONLY_DSN
// unset; the channel then reports "down" and degrades, never crashes.

export interface GraphNode {
  slug: string;
  title?: string;
  type?: string;
  updated_at?: string;
  degree: number;
  [k: string]: unknown;
}

export interface GraphEdge {
  /** source page slug */
  source: string;
  /** target page slug */
  target: string;
  link_type?: string;
  link_source?: string;
  [k: string]: unknown;
}

export interface GraphReport {
  status: CheckStatus;
  /**
   * Changes whenever the underlying pages/links change. Clients freeze FA2
   * layout coordinates per fingerprint so dream diffs stay comparable
   * (layout coordinates frozen — style-review hard constraint).
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
