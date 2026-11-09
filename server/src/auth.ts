import { createHash, timingSafeEqual } from "node:crypto";

// Token auth (ARCHITECTURE §5-2/3, decision D6 + 2026-11-09 amendment):
// a base COCKPIT_TOKEN (read + adjudicate, fail-closed) and an OPTIONAL
// COCKPIT_ADMIN_TOKEN that additionally unlocks management writes
// (0.4.0 ops routes). Two named tiers on the verify(token) → Principal seam
// D6 reserved for multi-token; the V2 registry (named tokens, revocation,
// read-only sharing) stays future work. Tokens travel only in the
// Authorization header — a token in the query string is a 400, not a
// fallback (they leak into logs and Referer).

export interface Principal {
  readonly name: string;
  /** "admin" only when the request carried the admin token verbatim. */
  readonly tier: "base" | "admin";
}

export class TokenVerifier {
  readonly #baseDigest: Buffer;
  readonly #adminDigest: Buffer | null;

  constructor(opts: { base: string; admin?: string | null }) {
    // Compare digests, not raw values: timingSafeEqual requires equal lengths,
    // and hashing first avoids leaking the token length through timing.
    this.#baseDigest = sha256(opts.base);
    this.#adminDigest = opts.admin ? sha256(opts.admin) : null;
  }

  /** True when an admin token is configured (management writes possible). */
  get adminConfigured(): boolean {
    return this.#adminDigest !== null;
  }

  /** Returns the principal iff the header carries one of the exact bearer tokens. */
  verify(authorizationHeader: string | null): Principal | null {
    const match = /^Bearer\s+(.+)$/.exec(authorizationHeader ?? "");
    if (!match?.[1]) return null;
    const digest = sha256(match[1]);
    // Admin is checked first. The tiers holding one identical value is a
    // config error rejected at startup; here the order only decides the tier
    // label, never access itself.
    if (this.#adminDigest && timingSafeEqual(digest, this.#adminDigest)) {
      return { name: "owner", tier: "admin" };
    }
    return timingSafeEqual(digest, this.#baseDigest)
      ? { name: "owner", tier: "base" }
      : null;
  }
}

/** True if any query param looks like a token — such requests are rejected. */
export function hasTokenInQuery(url: URL): boolean {
  for (const key of url.searchParams.keys()) {
    if (/token/i.test(key)) return true;
  }
  return false;
}

function sha256(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}
