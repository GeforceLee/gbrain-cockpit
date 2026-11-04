import { createHash, timingSafeEqual } from "node:crypto";

// Token auth (ARCHITECTURE §5-2/3, decision D6): V1 keeps a single
// COCKPIT_TOKEN, but the interface is shaped as verify(token) → Principal so
// V2's named multi-token list drops in without touching call sites. Tokens
// travel only in the Authorization header — a token in the query string is a
// 400, not a fallback (they leak into logs and Referer).

export interface Principal {
  readonly name: string;
}

export class TokenVerifier {
  readonly #expectedDigest: Buffer;

  constructor(token: string) {
    // Compare digests, not raw values: timingSafeEqual requires equal lengths,
    // and hashing first avoids leaking the token length through timing.
    this.#expectedDigest = sha256(token);
  }

  /** Returns the principal iff the header carries the exact bearer token. */
  verify(authorizationHeader: string | null): Principal | null {
    const match = /^Bearer\s+(.+)$/.exec(authorizationHeader ?? "");
    if (!match?.[1]) return null;
    const digest = sha256(match[1]);
    return timingSafeEqual(digest, this.#expectedDigest)
      ? { name: "owner" }
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
