// The cockpit bearer token's storage — split out of lib/api so lib/brain
// can read it without an api ↔ brain import cycle.

const TOKEN_KEY = "cockpit.token";

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string | null): void {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}
