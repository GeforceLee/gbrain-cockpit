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
  | "takes.resolve" // MCP takes_resolve
  | "page.write"; // MCP put_page / edit_page (receipt protocol)

/** The one and only channel an action may travel through. */
export type Channel = "mcp" | "cli-whitelist" | "copy-command";

/** cockpit's own version; shown in Health and sent as MCP clientInfo. */
export const COCKPIT_VERSION = "0.0.1";

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
  reason?: "binary-found-unverified" | "binary-not-found" | "not-configured-host";
  error?: string;
}

export interface BrainCheck {
  status: CheckStatus;
  identity?: BrainIdentity;
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
  };
}

export function worstStatus(...statuses: CheckStatus[]): CheckStatus {
  if (statuses.includes("down")) return "down";
  if (statuses.includes("degraded")) return "degraded";
  return "ok";
}
