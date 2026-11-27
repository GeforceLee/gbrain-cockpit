import type {
  TokenGrantsResponse,
  TokenIssuedResponse,
  TokensResponse,
} from "@gbrain-cockpit/shared";
import { OWNER_ADMIN, actorName, type Actor } from "../authz";
import { BadRequestError, envelope, readJsonBody } from "../http";
import type { TokenRegistry } from "../tokens";

// Token management (0.7, ROADMAP-named-tokens §3.1): four owner-only routes
// behind the router's "owner-only" class. Reads ride either env token; the
// three writes additionally need the admin tier (the 0.6 step-up discipline:
// the admin token is pasted per action and never stored in the browser).
// Request shapes are strict — an unknown key is a 400 — and the plaintext
// token exists in exactly one response body.

function notWired(): Response {
  return envelope(
    503,
    "E_NOT_CONFIGURED",
    "named tokens are off on this cockpit — set COCKPIT_TOKENS_FILE to turn them on",
  );
}

/** The router already refused named tokens; this is the owner's base token
 *  meeting a management write without the admin tier (two messages, as the
 *  grant-read and model-probe actions answer). */
function requireAdmin(
  actor: Actor,
  adminConfigured: boolean,
): Response | null {
  if (actor.kind !== "env") {
    return envelope(
      403,
      "E_FORBIDDEN",
      "this action is reserved for the owner's env tokens",
      {},
      { missing: "owner-only" },
    );
  }
  if (actor.tier !== "admin") {
    return envelope(
      403,
      "E_FORBIDDEN",
      adminConfigured
        ? "token management requires the COCKPIT_ADMIN_TOKEN tier — paste it at the action's step-up prompt"
        : "COCKPIT_ADMIN_TOKEN is not configured on this cockpit — set it in the server env to manage tokens",
      {},
      // the marker says "you pasted the wrong token"; when no admin token is
      // configured there is nothing to paste, and the message says so itself
      adminConfigured ? { missing: "admin-tier" as const } : {},
    );
  }
  return null;
}

function onlyKeys(
  body: Record<string, unknown>,
  allowed: readonly string[],
  what: string,
): void {
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) {
      throw new BadRequestError(`${what} does not accept the field "${key}"`);
    }
  }
}

/** GET /api/tokens — the roster: names, sheets, stamps. No hashes. */
export async function handleTokenList(
  tokens: TokenRegistry | null,
): Promise<Response> {
  if (!tokens) return notWired();
  const body: TokensResponse = { tokens: tokens.list() };
  return Response.json(body);
}

/** POST /api/tokens — issue. The plaintext rides this one response. */
export async function handleTokenIssue(
  tokens: TokenRegistry | null,
  actor: Actor,
  req: Request,
  adminConfigured: boolean,
): Promise<Response> {
  if (!tokens) return notWired();
  const refusal = requireAdmin(actor, adminConfigured);
  if (refusal) return refusal;
  const body = await readJsonBody(req);
  onlyKeys(body, ["name", "brains", "adjudicate", "editSources"], "token issue");
  const issued = await tokens.issue(
    {
      name: body.name,
      brains: body.brains,
      adjudicate: body.adjudicate,
      ...(body.editSources !== undefined ? { editSources: body.editSources } : {}),
    },
    actorName(OWNER_ADMIN),
  );
  const payload: TokenIssuedResponse = issued;
  return Response.json(payload, {
    status: 201,
    headers: { "cache-control": "no-store" },
  });
}

/** PUT /api/tokens/grants — replace the whole sheet. */
export async function handleTokenGrants(
  tokens: TokenRegistry | null,
  actor: Actor,
  req: Request,
  adminConfigured: boolean,
): Promise<Response> {
  if (!tokens) return notWired();
  const refusal = requireAdmin(actor, adminConfigured);
  if (refusal) return refusal;
  const body = await readJsonBody(req);
  onlyKeys(body, ["id", "brains", "adjudicate", "editSources"], "token grants");
  if (typeof body.id !== "string") {
    throw new BadRequestError("id must be a token id");
  }
  const record = await tokens.setGrants(
    body.id,
    { brains: body.brains, adjudicate: body.adjudicate, editSources: body.editSources },
    actorName(OWNER_ADMIN),
  );
  const payload: TokenGrantsResponse = { record };
  return Response.json(payload);
}

/** POST /api/tokens/revoke — idempotent, never undone. */
export async function handleTokenRevoke(
  tokens: TokenRegistry | null,
  actor: Actor,
  req: Request,
  adminConfigured: boolean,
): Promise<Response> {
  if (!tokens) return notWired();
  const refusal = requireAdmin(actor, adminConfigured);
  if (refusal) return refusal;
  const body = await readJsonBody(req);
  onlyKeys(body, ["id"], "token revoke");
  if (typeof body.id !== "string") {
    throw new BadRequestError("id must be a token id");
  }
  const record = await tokens.revoke(body.id, actorName(OWNER_ADMIN));
  const payload: TokenGrantsResponse = { record };
  return Response.json(payload);
}
