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

  return {
    bind: env.COCKPIT_BIND?.trim() || "127.0.0.1",
    port: parsePort(env.COCKPIT_PORT ?? "8787"),
    cockpitToken,
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
