// Single API client for the whole app: attaches the bearer token, parses the
// server's error envelope, and maps errors to user-language copy at call
// sites. Timeouts/backoff grow here in V1.0 (ARCHITECTURE §7).

const TOKEN_KEY = "cockpit.token";

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string | null): void {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

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
    headers: { authorization: `Bearer ${token}` },
  });
  const body = (await res.json().catch(() => null)) as (Envelope & T) | null;
  if (!res.ok) {
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
): Promise<T> {
  const token = getToken();
  if (!token) throw new ApiError("no token stored", "E_NO_TOKEN", 0);

  const res = await fetch(path, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  const body = (await res.json().catch(() => null)) as (Envelope & T) | null;
  if (!res.ok) {
    throw new ApiError(
      body?.error ?? `HTTP ${res.status}`,
      body?.code ?? "E_HTTP",
      res.status,
    );
  }
  return body as T;
}
