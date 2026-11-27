import { randomBytes } from "node:crypto";

// Configuration surface (ARCHITECTURE §8): env vars are the base layer,
// startup flags can come later. Startup fails closed on missing secrets
// (AGENTS.md non-negotiable #7) — a config error is fatal, never a warning.
//
// This module covers cockpit's OWN process config (bind/auth). Brain
// connection profiles live in profiles.ts: one gbrain deployment per
// profile, from COCKPIT_PROFILES_FILE or the legacy single-instance env.

export class ConfigError extends Error {
  /** Printable, actionable next step for the operator. */
  readonly hint: string;

  constructor(message: string, hint: string) {
    super(message);
    this.name = "ConfigError";
    this.hint = hint;
  }
}

export interface Config {
  readonly bind: string;
  readonly port: number;
  readonly cockpitToken: string;
  /**
   * Optional management tier (0.4.0, D6 amendment): unlocks management
   * writes only. Unset ⇒ management writes answer 403 in-band and the UI
   * falls back to copy-commands — single-token installs behave exactly as
   * before. Never equals the base token (validated).
   */
  readonly adminToken: string | null;
  /**
   * COCKPIT_TOKENS_FILE (0.7 named tokens): absolute path of the token
   * registry. Unset ⇒ the feature is off — only the two env tokens
   * authenticate, which is 0.6 behaviour exactly.
   */
  readonly tokensFile: string | null;
  /**
   * COCKPIT_ALLOWED_ORIGINS: canonical origins (scheme://host[:port])
   * accepted on state-changing requests when the reverse proxy rewrites
   * Host, so "Origin equals Host" alone would refuse every browser write.
   * Each entry is validated at startup; a typo fails the boot, never a
   * request. Unset/empty ⇒ empty list (the check is unchanged).
   */
  readonly allowedOrigins: readonly string[];
}

export function loadConfig(
  env: Record<string, string | undefined> = process.env,
): Config {
  const cockpitToken = env.COCKPIT_TOKEN?.trim();
  if (!cockpitToken) {
    // Fail closed, but hand the operator a ready-to-use secret so the first
    // run is one copy-paste away from working.
    const generated = randomBytes(32).toString("base64url");
    throw new ConfigError(
      "COCKPIT_TOKEN is required (fail-closed: no token, no server).",
      `generated a strong token for you:\n  COCKPIT_TOKEN=${generated}\nput it in .env (or the environment) and start again.`,
    );
  }

  const adminToken = env.COCKPIT_ADMIN_TOKEN?.trim() || null;
  if (adminToken === cockpitToken) {
    // One value for both tiers would collapse admin onto every read+adjudicate
    // request — the exact privilege merge the split exists to prevent.
    const generated = randomBytes(32).toString("base64url");
    throw new ConfigError(
      "COCKPIT_ADMIN_TOKEN must differ from COCKPIT_TOKEN.",
      `generated a strong admin token for you:\n  COCKPIT_ADMIN_TOKEN=${generated}\nput it in .env (or the environment) and start again.`,
    );
  }

  return {
    bind: env.COCKPIT_BIND?.trim() || "127.0.0.1",
    port: parsePort(env.COCKPIT_PORT ?? "8787"),
    cockpitToken,
    adminToken,
    tokensFile: parseTokensFile(env.COCKPIT_TOKENS_FILE),
    allowedOrigins: parseAllowedOrigins(env.COCKPIT_ALLOWED_ORIGINS),
  };
}

function parsePort(raw: string): number {
  const port = Number.parseInt(raw, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigError(
      `invalid COCKPIT_PORT: ${raw}`,
      "use a TCP port between 1 and 65535.",
    );
  }
  return port;
}

function parseTokensFile(raw: string | undefined): string | null {
  const file = raw?.trim();
  if (!file) return null;
  if (!file.startsWith("/")) {
    // A relative path resolves against the working directory — which on a
    // managed host IS the release dir, so the registry would vanish on the
    // next deploy (or get shipped inside a release).
    throw new ConfigError(
      "COCKPIT_TOKENS_FILE must be an absolute path.",
      `got: ${file}\nput the registry outside the release tree, e.g. /home/you/cockpit/tokens.json`,
    );
  }
  return file;
}

const MAX_ALLOWED_ORIGINS = 16;

/**
 * COCKPIT_ALLOWED_ORIGINS → canonical origins, or a ConfigError naming the
 * bad entry. The canonical-form rule (`new URL(entry).origin === entry`) is
 * what keeps the list exact-match: a differently-cased host, a trailing
 * slash, a path or `:443` would all normalize to the same origin at request
 * time, so they are refused here with the canonical spelling in the hint.
 */
export function parseAllowedOrigins(raw: string | undefined): string[] {
  const out: string[] = [];
  for (const piece of (raw ?? "").split(",")) {
    const entry = piece.trim();
    if (!entry) continue;
    let u: URL;
    try {
      u = new URL(entry);
    } catch {
      throw new ConfigError(
        `COCKPIT_ALLOWED_ORIGINS: not a site address: ${entry}`,
        'entries look like https://cockpit.example.com (scheme, host, optional port — no path).',
      );
    }
    if (u.protocol !== "https:" && !(u.protocol === "http:" && isLoopback(u.hostname))) {
      throw new ConfigError(
        `COCKPIT_ALLOWED_ORIGINS: only https:// is accepted (http:// just for loopback): ${entry}`,
        "browser writes carry the public origin; serve cockpit over https, or use http://127.0.0.1:<port> for a local-only setup.",
      );
    }
    if (u.hostname === "" || u.hostname.includes("*")) {
      // parses, and would look like a wildcard, but the check is exact-match:
      // a dirty entry must fail the boot rather than sit there doing nothing
      throw new ConfigError(
        `COCKPIT_ALLOWED_ORIGINS: an entry must name one exact host: ${entry}`,
        "wildcards are not supported — list each origin the browsers use.",
      );
    }
    if (u.username !== "" || u.password !== "") {
      throw new ConfigError(
        `COCKPIT_ALLOWED_ORIGINS: an entry must not carry account information: ${entry}`,
        "use the bare scheme://host[:port] form.",
      );
    }
    if (u.origin !== entry) {
      throw new ConfigError(
        `COCKPIT_ALLOWED_ORIGINS: not in canonical form: ${entry}`,
        `write it exactly as ${u.origin} (lowercase host, no trailing slash, no path, no default port).`,
      );
    }
    if (!out.includes(u.origin)) out.push(u.origin);
  }
  if (out.length > MAX_ALLOWED_ORIGINS) {
    throw new ConfigError(
      `COCKPIT_ALLOWED_ORIGINS: more than ${MAX_ALLOWED_ORIGINS} entries`,
      "list only the origins browsers actually reach cockpit through.",
    );
  }
  return out;
}

function isLoopback(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]";
}
