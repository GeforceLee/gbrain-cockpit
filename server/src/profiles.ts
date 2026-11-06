import { lstatSync, readFileSync } from "node:fs";
import {
  OWNER_BIN_RE,
  PROFILE_ID_RE,
  type BrainProfileConfig,
} from "@gbrain-cockpit/shared";
import { ConfigError } from "./config";

// Brain connection profiles (multi-brain switching, ARCHITECTURE §8): one
// gbrain deployment per profile — MCP endpoint + credential + optional
// read-only PG DSN + optional CLI command name/path. The profile layer
// switches ENDPOINTS AND CREDENTIALS ONLY; it can never reroute an action
// across channel types (AGENTS.md non-negotiable #4 — the channel matrix
// stays a compile-time constant), and no profile field may ever name a
// channel, subcommand, flag or SQL.
//
// Secrets discipline: ConfigError messages and every log line reference
// profile ids and FIELD NAMES only — never file contents, tokens or DSNs.
// The file mode fail-closes on every malformed shape; the legacy single-
// instance env path reproduces 0.1.1 semantics exactly.

/** A parsed OAuth client-credentials handoff (`gbrain mcp grant`). */
export interface OAuthCredential {
  issuerUrl: string;
  clientId: string;
  clientSecret: string;
  accessToken?: string;
  /** epoch seconds */
  expiresAt?: number;
}

/** A profile as the server holds it (adds the parsed OAuth handoff). */
export interface ResolvedProfile extends BrainProfileConfig {
  oauth?: OAuthCredential;
}

export interface ProfilesConfig {
  profiles: ResolvedProfile[];
  defaultId: string;
  mode: "file" | "legacy-env";
  /** legacy brain env vars present while the file mode won — caller logs them */
  ignoredLegacyVars: string[];
}

export const DEFAULT_PROFILE_ID = "default";

const LEGACY_BRAIN_VARS = [
  "GBRAIN_MCP_URL",
  "GBRAIN_MCP_TOKEN",
  "GBRAIN_TAKES_HOLDERS",
  "GBRAIN_BIN",
  "PG_READONLY_DSN",
] as const;

export interface LoadProfilesDeps {
  /** injectable for tests; serves both the profiles file and credential files */
  readFile?: (path: string) => string;
  /** injectable for tests: the credentials-file hygiene pre-check */
  lstat?: (path: string) => {
    isSymbolicLink: boolean;
    isFile: boolean;
    size: number;
    mode: number;
  };
}

function defaultLstat(path: string): {
  isSymbolicLink: boolean;
  isFile: boolean;
  size: number;
  mode: number;
} {
  const st = lstatSync(path);
  return {
    isSymbolicLink: st.isSymbolicLink(),
    isFile: st.isFile(),
    size: st.size,
    mode: st.mode,
  };
}

export function loadProfiles(
  env: Record<string, string | undefined> = process.env,
  deps: LoadProfilesDeps = {},
): ProfilesConfig {
  const readFile = deps.readFile ?? ((p: string) => readFileSync(p, "utf8"));
  const file = env.COCKPIT_PROFILES_FILE?.trim();
  if (file) {
    return loadFromFile(file, env, readFile, deps.lstat ?? defaultLstat);
  }
  return loadLegacy(env);
}

// --- file mode --------------------------------------------------------------

function loadFromFile(
  file: string,
  env: Record<string, string | undefined>,
  readFile: (path: string) => string,
  lstat: NonNullable<LoadProfilesDeps["lstat"]>,
): ProfilesConfig {
  let text: string;
  try {
    text = readFile(file);
  } catch {
    throw new ConfigError(
      `COCKPIT_PROFILES_FILE is set but unreadable: ${file}`,
      "check the path and permissions — the file holds gbrain MCP credentials, keep it 0600 and outside the repo.",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ConfigError(
      `COCKPIT_PROFILES_FILE is not valid JSON: ${file}`,
      "fix the file; cockpit never echoes its contents here.",
    );
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new ConfigError(
      `COCKPIT_PROFILES_FILE must be a non-empty JSON array of profiles: ${file}`,
      'example: [{"id":"atlas","name":"atlas-brain","mcpUrl":"http://127.0.0.1:3131/mcp","mcpToken":"…"}] — see .env.example',
    );
  }
  const seen = new Set<string>();
  const profiles = parsed.map((raw, i) => {
    const profile = validateProfile(raw, i, readFile, lstat);
    if (seen.has(profile.id)) {
      throw new ConfigError(
        `duplicate profile id: ${profile.id}`,
        "profile ids must be unique — they route the x-brain-profile header.",
      );
    }
    seen.add(profile.id);
    return profile;
  });
  const ignoredLegacyVars = LEGACY_BRAIN_VARS.filter((v) => env[v]?.trim());
  return {
    profiles,
    defaultId: profiles[0]!.id,
    mode: "file",
    ignoredLegacyVars,
  };
}

function validateProfile(
  raw: unknown,
  i: number,
  readFile: (path: string) => string,
  lstat: NonNullable<LoadProfilesDeps["lstat"]>,
): ResolvedProfile {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigError(
      `profiles[${i}] must be an object`,
      "each entry: id, name?, mcpUrl, mcpToken | mcpCredentials, cliBin?, pgReadonlyDsn?, takesHolders?",
    );
  }
  const p = raw as Record<string, unknown>;
  const id = typeof p.id === "string" ? p.id : "";
  if (!PROFILE_ID_RE.test(id)) {
    throw new ConfigError(
      `profiles[${i}].id is invalid: ${JSON.stringify(id)}`,
      "lowercase kebab, 1..32 chars ([a-z0-9][a-z0-9-]*) — it routes the x-brain-profile header.",
    );
  }
  const name =
    typeof p.name === "string" && p.name.trim() ? p.name.trim() : id;
  const mcpUrl = typeof p.mcpUrl === "string" ? p.mcpUrl.trim() : "";
  if (!mcpUrl) {
    throw new ConfigError(
      `profile ${id}: mcpUrl is required`,
      "file mode has no default endpoint — an omitted URL would silently point two profiles at one brain.",
    );
  }
  try {
    const u = new URL(mcpUrl);
    if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error();
  } catch {
    throw new ConfigError(
      `profile ${id}: mcpUrl must be an http(s) URL`,
      `got: ${mcpUrl}`,
    );
  }
  const token = nonEmpty(p.mcpToken);
  const credPath = nonEmpty(p.mcpCredentials);
  let oauth: OAuthCredential | undefined;
  if (!token && !credPath) {
    throw new ConfigError(
      `profile ${id}: missing MCP credential`,
      "set mcpToken (static bearer, `gbrain auth create`) or mcpCredentials (path to a `gbrain mcp grant --credentials-out` handoff).",
    );
  }
  if (token && credPath) {
    throw new ConfigError(
      `profile ${id}: mcpToken and mcpCredentials are mutually exclusive`,
      "pick exactly one credential per profile.",
    );
  }
  if (credPath) oauth = loadCredentialFile(id, credPath, readFile, lstat);
  const cliBin = nonEmpty(p.cliBin);
  if (cliBin && !OWNER_BIN_RE.test(cliBin)) {
    throw new ConfigError(
      `profile ${id}: cliBin failed the command-name/path charset`,
      "a bare name like gbrain-bip, or an absolute path — no whitespace or shell metachars (the string is pasted into the owner's shell).",
    );
  }
  const pgReadonlyDsn = nonEmpty(p.pgReadonlyDsn);
  const takesHolders = Array.isArray(p.takesHolders)
    ? p.takesHolders.filter(
        (h): h is string => typeof h === "string" && !!h.trim(),
      )
    : undefined;
  return {
    id,
    name,
    mcpUrl,
    ...(token ? { mcpToken: token } : {}),
    ...(credPath ? { mcpCredentials: credPath } : {}),
    ...(oauth ? { oauth } : {}),
    ...(cliBin ? { cliBin } : {}),
    ...(pgReadonlyDsn ? { pgReadonlyDsn } : {}),
    ...(takesHolders && takesHolders.length > 0 ? { takesHolders } : {}),
  };
}

/** Mirror of upstream's credentials-file hygiene (src/core/harness/credentials.ts). */
function loadCredentialFile(
  id: string,
  path: string,
  readFile: (path: string) => string,
  lstat: NonNullable<LoadProfilesDeps["lstat"]>,
): OAuthCredential {
  try {
    const st = lstat(path);
    if (st.isSymbolicLink) throw new Error("is a symlink");
    if (!st.isFile) throw new Error("not a regular file");
    if (st.size > 64 * 1024) throw new Error("larger than 64KB");
    if (st.mode & 0o077) {
      console.warn(
        `[profiles] profile ${id}: credentials file is group/world readable — chmod 600 ${path}`,
      );
    }
  } catch (err) {
    throw new ConfigError(
      `profile ${id}: cannot use the credentials file at ${path}`,
      `it must exist as a regular, non-symlink file of at most 64KB (${(err as Error).message}).`,
    );
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(readFile(path)) as Record<string, unknown>;
  } catch {
    throw new ConfigError(
      `profile ${id}: credentials file is not valid JSON`,
      "re-run `gbrain mcp grant --credentials-out` on the brain host.",
    );
  }
  const clientId = nonEmpty(parsed.client_id);
  const clientSecret = nonEmpty(parsed.client_secret);
  const issuerUrl = nonEmpty(parsed.issuer_url);
  if (!clientId || !clientSecret || !issuerUrl) {
    throw new ConfigError(
      `profile ${id}: credentials file misses client_id / client_secret / issuer_url`,
      "re-run `gbrain mcp grant --credentials-out` on the brain host.",
    );
  }
  try {
    const u = new URL(issuerUrl);
    if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error();
  } catch {
    throw new ConfigError(
      `profile ${id}: credentials issuer_url must be an http(s) URL`,
      "re-run `gbrain mcp grant --credentials-out` on the brain host.",
    );
  }
  const accessToken = nonEmpty(parsed.access_token);
  const expiresAt =
    typeof parsed.expires_at === "number" && Number.isFinite(parsed.expires_at)
      ? parsed.expires_at
      : undefined;
  return {
    issuerUrl,
    clientId,
    clientSecret,
    ...(accessToken ? { accessToken } : {}),
    ...(expiresAt !== undefined ? { expiresAt } : {}),
  };
}

// --- legacy single-instance env (0.1.1 semantics, byte for byte) ------------

function loadLegacy(env: Record<string, string | undefined>): ProfilesConfig {
  const mcpToken = env.GBRAIN_MCP_TOKEN?.trim();
  if (!mcpToken) {
    throw new ConfigError(
      "GBRAIN_MCP_TOKEN is required (fail-closed).",
      "mint one on the brain host:\n" +
        "  gbrain auth create cockpit-ui --scopes read,write,memory_confirm --takes-holders <all-holders>\n" +
        "note: takes holders default to 'world' (fail-closed on gbrain's side) —\n" +
        "list every holder, or the takes queues will look empty in the UI.\n" +
        "multi-brain? put credentials in a COCKPIT_PROFILES_FILE instead (see .env.example).",
    );
  }
  const holders = splitList(env.GBRAIN_TAKES_HOLDERS);
  return {
    profiles: [
      {
        id: DEFAULT_PROFILE_ID,
        name: "gbrain",
        mcpUrl: env.GBRAIN_MCP_URL?.trim() || "http://127.0.0.1:3131/mcp",
        mcpToken,
        ...(nonEmpty(env.GBRAIN_BIN)
          ? { cliBin: nonEmpty(env.GBRAIN_BIN)! }
          : {}),
        ...(nonEmpty(env.PG_READONLY_DSN)
          ? { pgReadonlyDsn: nonEmpty(env.PG_READONLY_DSN)! }
          : {}),
        ...(holders ? { takesHolders: holders } : {}),
      },
    ],
    defaultId: DEFAULT_PROFILE_ID,
    mode: "legacy-env",
    ignoredLegacyVars: [],
  };
}

function splitList(raw: string | undefined): string[] | null {
  const list = (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return list.length > 0 ? list : null;
}

function nonEmpty(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const v = raw.trim();
  return v ? v : undefined;
}
