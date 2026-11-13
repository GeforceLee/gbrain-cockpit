// Single API client for the whole app: attaches the bearer token, parses the
// server's error envelope, and maps errors to user-language copy at call
// sites. Timeouts/backoff grow here in V1.0 (ARCHITECTURE §7).

// Token storage lives in lib/token (shared with lib/brain without a cycle).
export { getToken, setToken } from "./token";

import { getToken } from "./token";
import { currentProfileId, healAfterUnknownProfile } from "./brain";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

interface Envelope {
  error?: string;
  code?: string;
}

export async function apiGet<T>(path: string): Promise<T> {
  const token = getToken();
  if (!token) throw new ApiError("no token stored", "E_NO_TOKEN", 0);

  const res = await fetch(path, {
    headers: withProfile({ authorization: `Bearer ${token}` }),
    // a hung cockpit must not leave the UI busy forever (V1.0 promise, paid)
    signal: AbortSignal.timeout(30_000),
  });
  const body = (await res.json().catch(() => null)) as (Envelope & T) | null;
  if (!res.ok) {
    if (res.status === 400 && mentionsProfile(body)) {
      // the persisted profile vanished server-side — heal once, then fail
      void healAfterUnknownProfile();
    }
    throw new ApiError(
      body?.error ?? `HTTP ${res.status}`,
      body?.code ?? "E_HTTP",
      res.status,
    );
  }
  return body as T;
}

export async function apiSend<T>(
  path: string,
  method: "POST" | "PUT",
  payload: unknown,
  opts: { token?: string; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<T> {
  // opts.token overrides the stored bearer for THIS request only — the
  // management step-up (0.4.0): the admin token is pasted at the action,
  // travels in the Authorization header of that one call, and is never
  // written to persistent storage. opts.timeoutMs widens the abort budget
  // for calls whose server side legitimately outlives the default (the live
  // model probe runs paid reachability checks with retries). opts.signal is
  // the CALLER's cancel (the ask panel's "cut the tape"): it fires alongside
  // the timeout budget, whichever comes first.
  const token = opts.token ?? getToken();
  if (!token) throw new ApiError("no token stored", "E_NO_TOKEN", 0);

  const signals: AbortSignal[] = [AbortSignal.timeout(opts.timeoutMs ?? 30_000)];
  if (opts.signal) signals.push(opts.signal);
  const res = await fetch(path, {
    method,
    headers: withProfile({
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    }),
    body: JSON.stringify(payload),
    signal: signals.length === 1 ? signals[0] : AbortSignal.any(signals),
  });
  const body = (await res.json().catch(() => null)) as (Envelope & T) | null;
  if (!res.ok) {
    if (res.status === 400 && mentionsProfile(body)) {
      void healAfterUnknownProfile();
    }
    throw new ApiError(
      body?.error ?? `HTTP ${res.status}`,
      body?.code ?? "E_HTTP",
      res.status,
    );
  }
  return body as T;
}

/** Attach the brain-routing header whenever a non-default profile is active. */
function withProfile(
  headers: Record<string, string>,
): Record<string, string> {
  const id = currentProfileId();
  return id ? { ...headers, "x-brain-profile": id } : headers;
}

function mentionsProfile(body: Envelope | null): boolean {
  return (body?.error ?? "").includes("brain profile");
}
