import type {
  MePermissions,
  MeResponse,
  PermissionMissing,
} from "@gbrain-cockpit/shared";
import type { TokenVerifier } from "./auth";
import type { TokenRegistry, TokenEntry } from "./tokens";

// Authorization (0.7 named tokens): ONE function decides whether a caller
// may use a route class, and every route declares its class in the router
// table — handlers never re-check. The default for a named token is deny:
// `authorize` knows exactly three grantable classes (view is implicit,
// adjudicate and edit come off the sheet) and refuses everything else,
// including any class added later (the exhaustive switch fails to compile
// until the new class gets a verdict).
//
// The owner's two env tokens bypass the sheet: they keep every class they
// had, and only the management writes still need the admin tier.

export type PermClass = "view" | "adjudicate" | "edit" | "owner-only";

/** Who is calling — the audit trail's "who" and the sheet being enforced. */
export interface Actor {
  readonly kind: "env" | "token";
  /** sheet name; "owner" for the env tokens */
  readonly name: string;
  /** env tokens only */
  readonly tier?: "base" | "admin";
  /** named tokens only */
  readonly tokenId?: string;
  readonly brains?: readonly string[];
  readonly adjudicate?: boolean;
  readonly editSources?: readonly string[];
}

export const OWNER_BASE: Actor = Object.freeze({
  kind: "env",
  name: "owner",
  tier: "base",
});

export const OWNER_ADMIN: Actor = Object.freeze({
  kind: "env",
  name: "owner",
  tier: "admin",
});

/** The audit line's `actor`: env tokens keep the 0.6 strings exactly. */
export function actorName(actor: Actor | undefined): string {
  const a = actor ?? OWNER_BASE;
  return a.kind === "env" && a.tier === "admin" ? "owner (admin)" : a.name;
}

export interface Denial {
  missing: PermissionMissing;
  source?: string;
}

export function authorize(actor: Actor, perm: PermClass): Denial | null {
  switch (perm) {
    case "view":
      return null;
    case "adjudicate":
      return actor.kind === "env" || actor.adjudicate === true
        ? null
        : { missing: "adjudicate" };
    case "edit":
      // Route level (R0): a named token with no edit grant at all is
      // refused before its body is read. The per-source check (R2) is
      // `authorizeEditSource`; until the second step opens editing, no
      // named token can hold an edit grant.
      return actor.kind === "env" || (actor.editSources?.length ?? 0) > 0
        ? null
        : { missing: "edit" };
    case "owner-only":
      return actor.kind === "env" ? null : { missing: "owner-only" };
    default: {
      const exhaustive: never = perm;
      return exhaustive;
    }
  }
}

/** R2 — may this actor edit the named source (step 2 wires the write
 *  channel; the sheet check is ready). */
export function authorizeEditSource(
  actor: Actor,
  source: string | undefined,
): Denial | null {
  if (actor.kind === "env") return null;
  if (source === undefined) return { missing: "edit" };
  return actor.editSources?.includes(source) ? null : { missing: "edit", source };
}

/**
 * The brain gate for named tokens. `known` false (the profile is gone from
 * brains.json) and "not on the sheet" answer the SAME denial — and it does
 * not echo the id — so a token cannot probe which brains exist.
 */
export function brainDenied(
  actor: Actor,
  brain: string,
  known: boolean,
): Denial | null {
  if (actor.kind === "env") return null;
  if (!known || actor.brains?.includes(brain) !== true) {
    return { missing: "brain" };
  }
  return null;
}

/**
 * Verify the bearer header: the two env tokens first (the 0.6 verifier,
 * unchanged), then the named-token registry. Null = 401, byte-identical
 * for "revoked" and "never existed" (both are simply absent from the
 * active index).
 */
export function authenticate(
  verifier: TokenVerifier,
  tokens: TokenRegistry | null,
  authorizationHeader: string | null,
): Actor | null {
  const env = verifier.verify(authorizationHeader);
  if (env) return env.tier === "admin" ? OWNER_ADMIN : OWNER_BASE;
  if (!tokens) return null;
  const entry = tokens.verify(authorizationHeader);
  return entry === null ? null : actorOfEntry(entry);
}

export function actorOfEntry(entry: TokenEntry): Actor {
  return {
    kind: "token",
    name: entry.name,
    tokenId: entry.id,
    brains: entry.brains,
    adjudicate: entry.adjudicate,
    editSources: entry.editSources,
  };
}

export function meResponse(
  actor: Actor,
  opts: { adminConfigured: boolean; brains: readonly string[]; tokensWired: boolean },
): MeResponse {
  const owner = actor.kind === "env";
  const admin = owner && actor.tier === "admin";
  const permissions: MePermissions = owner
    ? {
        adjudicate: true,
        editSources: "all",
        ops: true,
        paidThink: true,
        tokens: opts.tokensWired,
        tokensWrite: opts.tokensWired && admin,
      }
    : {
        adjudicate: actor.adjudicate === true,
        editSources: [...(actor.editSources ?? [])],
        ops: false,
        paidThink: false,
        tokens: false,
        tokensWrite: false,
      };
  return {
    kind: owner ? "owner" : "token",
    name: actor.name,
    // a deployment detail of the owner's UI — never a named token's concern
    adminConfigured: owner && opts.adminConfigured,
    brains: owner ? [...opts.brains] : [...(actor.brains ?? [])],
    defaultBrain: owner
      ? (opts.brains[0] ?? "")
      : (actor.brains?.[0] ?? ""),
    permissions,
  };
}
