// Single API client for the whole app: attaches the bearer token, parses the
// server's error envelope, and maps errors to user-language copy at call
// sites. Timeouts/backoff grow here in V1.0 (ARCHITECTURE §7).
//
// 0.7 (named tokens): a 401 on the STORED token means the token is invalid
// or was revoked — the session is over, so the app clears it and reloads to
// the login gate. A 401/403 on a STEP-UP request (a pasted admin token,
// `opts.token`) is that action's own problem: it is thrown to the caller and
// never logs the session out. The distinction is made by WHICH credential
// the request used, never by looking at the response.

// Token storage lives in lib/token (shared with lib/brain without a cycle).
export { getToken, setToken } from "./token";

import type { MeResponse, PermissionMissing } from "@gbrain-cockpit/shared";
import { translate, type MessageKey } from "./i18n";
import { getToken, setToken } from "./token";
import { currentProfileId, healAfterBrainDenied, healAfterUnknownProfile, resetBrainState } from "./brain";
import { setMe } from "./me";
import { forbiddenMessage } from "./forbidden";

// Mount-point prefix for runtime fetch URLs: vite dev serves from "/"
// (BASE_URL "/", prefix empty — local dev untouched), release builds set
// base /cockpit/ (BASE_URL "/cockpit/"). The edge proxy strips the prefix
// before :8787, so API calls must carry it from the browser. vite's base
// rewrites index.html asset refs only — runtime strings like these fetch
// paths go through withBase instead.
const BASE = (import.meta.env.BASE_URL ?? "/").replace(/\/$/, "");
export const withBase = (path: string) => BASE + path;

/** Which credential a request used — decides what a 401 means. */
export type Credential = "session" | "step-up";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
    readonly extra: {
      credential?: Credential;
      /** E_FORBIDDEN: the grant the caller lacks */
      missing?: PermissionMissing;
      /** with missing "edit": the source that was not granted */
      source?: string;
      /** the server's own words, never localized — for logs and audits */
      raw?: string;
    } = {},
  ) {
    super(message);
    this.name = "ApiError";
  }
}

interface Envelope {
  error?: string;
  code?: string;
  missing?: PermissionMissing;
  source?: string;
}

/** The session is over (invalid or revoked token): clear everything and
 *  reload into the login gate. A one-shot reason survives the reload so the
 *  gate can say why. */
export function expireSession(): void {
  setToken(null);
  resetBrainState();
  setMe(null);
  try {
    sessionStorage.setItem("cockpit.logoutReason", "revoked");
  } catch {
    // no storage — the gate simply asks for a token
  }
  window.location.reload();
}

/** Explicit sign-out. Always a full reload: on a shared computer nothing of
 *  the previous person's session may remain (panels, session log, brain). */
export function logout(): void {
  setToken(null);
  resetBrainState();
  setMe(null);
  try {
    sessionStorage.removeItem("cockpit.logoutReason");
  } catch {
    // no storage
  }
  window.location.reload();
}

/** Take the one-shot reason the gate should show, if any. */
export function takeLogoutReason(): "revoked" | null {
  try {
    const reason = sessionStorage.getItem("cockpit.logoutReason");
    sessionStorage.removeItem("cockpit.logoutReason");
    return reason === "revoked" ? "revoked" : null;
  } catch {
    return null;
  }
}

/** The locale line for a mapped code, with the server's words as detail. */
function plainLine(code: string | undefined, raw: string): string {
  const key = `error.${code ?? ""}` as MessageKey;
  const mapped = translate(key);
  if (mapped === key) return raw;
  return mapped === raw ? mapped : `${mapped} · ${raw}`;
}

function toError(res: Response, body: Envelope | null, credential: Credential): ApiError {
  // Panels show `err.message` directly, so the plain line is put on the
  // message itself: a refusal names the missing grant, and every code with
  // a locale line reads in the user's language. The server's own words
  // stay on `raw` for the session log (which is never localized).
  const raw = body?.error ?? `HTTP ${res.status}`;
  const code = body?.code ?? "E_HTTP";
  const plain =
    res.status === 403 && body?.missing
      ? forbiddenMessage(body.missing, body.source)
      : plainLine(code, raw);
  return new ApiError(plain, code, res.status, {
    credential,
    raw,
    ...(body?.missing ? { missing: body.missing } : {}),
    ...(body?.source ? { source: body.source } : {}),
  });
}

/** What a non-2xx means for the session, done once for GET and SEND. */
function fail(res: Response, body: Envelope | null, credential: Credential): ApiError {
  const err = toError(res, body, credential);
  if (res.status === 401 && credential === "session") {
    expireSession();
    return err;
  }
  if (res.status === 400 && mentionsProfile(body)) {
    // the persisted profile vanished server-side — heal once, then fail
    void healAfterUnknownProfile();
  }
  if (res.status === 403 && body?.missing === "brain") {
    // the sheet no longer lists the brain being viewed — switch to one it does
    void healAfterBrainDenied();
  }
  return err;
}

export async function apiGet<T>(path: string): Promise<T> {
  const token = getToken();
  if (!token) throw new ApiError(translate("error.E_NO_TOKEN"), "E_NO_TOKEN", 0);

  const res = await fetch(withBase(path), {
    headers: withProfile({ authorization: `Bearer ${token}` }),
    // a hung cockpit must not leave the UI busy forever (V1.0 promise, paid)
    signal: AbortSignal.timeout(30_000),
  });
  const body = (await res.json().catch(() => null)) as (Envelope & T) | null;
  if (!res.ok) throw fail(res, body, "session");
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
  const stepUp = opts.token !== undefined;
  const token = opts.token ?? getToken();
  if (!token) throw new ApiError(translate("error.E_NO_TOKEN"), "E_NO_TOKEN", 0);

  const signals: AbortSignal[] = [AbortSignal.timeout(opts.timeoutMs ?? 30_000)];
  if (opts.signal) signals.push(opts.signal);
  const res = await fetch(withBase(path), {
    method,
    headers: withProfile({
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    }),
    body: JSON.stringify(payload),
    signal: signals.length === 1 ? signals[0] : AbortSignal.any(signals),
  });
  const body = (await res.json().catch(() => null)) as (Envelope & T) | null;
  if (!res.ok) throw fail(res, body, stepUp ? "step-up" : "session");
  return body as T;
}

/**
 * Ask the server who a token is BEFORE it is stored (login): a wrong or
 * revoked token is refused at the gate instead of being saved and then
 * bouncing every panel into 401s.
 */
export async function verifyToken(token: string): Promise<MeResponse> {
  const res = await fetch(withBase("/api/me"), {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await res.json().catch(() => null)) as (Envelope & MeResponse) | null;
  if (!res.ok) {
    throw new ApiError(
      body?.error ?? `HTTP ${res.status}`,
      body?.code ?? "E_HTTP",
      res.status,
    );
  }
  return body as MeResponse;
}

/** Attach the brain-routing header (see lib/brain currentProfileId). */
function withProfile(
  headers: Record<string, string>,
): Record<string, string> {
  const id = currentProfileId();
  return id ? { ...headers, "x-brain-profile": id } : headers;
}

function mentionsProfile(body: Envelope | null): boolean {
  return (body?.error ?? "").includes("brain profile");
}
