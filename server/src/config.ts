import { randomBytes } from "node:crypto";

// Configuration surface (ARCHITECTURE §8): env vars are the base layer,
// startup flags can come later. Startup fails closed on missing secrets
// (AGENTS.md non-negotiable #7) — a config error is fatal, never a warning.

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
  readonly gbrainMcpUrl: string;
  readonly gbrainMcpToken: string;
  readonly gbrainTakesHolders: string[] | null;
  readonly gbrainBin: string | null;
  readonly pgReadonlyDsn: string | null;
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

  const gbrainMcpToken = env.GBRAIN_MCP_TOKEN?.trim();
  if (!gbrainMcpToken) {
    throw new ConfigError(
      "GBRAIN_MCP_TOKEN is required (fail-closed).",
      "mint one on the brain host:\n" +
        "  gbrain auth create cockpit-ui --scopes read,write,memory_confirm --takes-holders <all-holders>\n" +
        "note: takes holders default to 'world' (fail-closed on gbrain's side) —\n" +
        "list every holder, or the takes queues will look empty in the UI.",
    );
  }

  return {
    bind: env.COCKPIT_BIND?.trim() || "127.0.0.1",
    port: parsePort(env.COCKPIT_PORT ?? "8787"),
    cockpitToken,
    gbrainMcpUrl: env.GBRAIN_MCP_URL?.trim() || "http://127.0.0.1:3131/mcp",
    gbrainMcpToken,
    gbrainTakesHolders: splitList(env.GBRAIN_TAKES_HOLDERS),
    gbrainBin: nonEmpty(env.GBRAIN_BIN),
    pgReadonlyDsn: nonEmpty(env.PG_READONLY_DSN),
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

function splitList(raw: string | undefined): string[] | null {
  const list = (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return list.length > 0 ? list : null;
}

function nonEmpty(raw: string | undefined): string | null {
  const v = raw?.trim();
  return v ? v : null;
}
