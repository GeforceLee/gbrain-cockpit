import { PROFILE_ID_RE, type ErrorCode } from "@gbrain-cockpit/shared";
import { COCKPIT_VERSION } from "@gbrain-cockpit/shared";
import { existsSync } from "node:fs";
import { TokenVerifier } from "./auth";
import { BrainRegistry } from "./brains";
import { loadConfig, ConfigError, type Config } from "./config";
import { createInboxStateStore } from "./inbox-state";
import { loadRootEnv } from "./env";
import { envelope, guardRequest, withApiHeaders } from "./http";
import { loadProfiles } from "./profiles";
import { serveStatic } from "./static";
import { TokenRegistry } from "./tokens";
import { OWNER_ADMIN } from "./authz";
import { auditWrite, auditWriteStrict, ensureAuditWritable } from "./audit";
import { handleApi, type RouteDeps } from "./router";
import { getHealthReport, toCoarse } from "./routes/health";
import { mapError } from "./routes/api";

loadRootEnv();

let cfg: Config;
try {
  cfg = loadConfig();
} catch (err) {
  if (err instanceof ConfigError) {
    console.error(`[cockpit] config error: ${err.message}`);
    console.error(`[cockpit] ${err.hint}`);
    process.exit(1);
  }
  throw err;
}

// Brain connection profiles: COCKPIT_PROFILES_FILE (multi-brain) or the
// legacy single-instance GBRAIN_* env wrapped as one "default" profile.
// Startup logs profile ids and channel availability ONLY — never tokens,
// DSNs or file contents (AGENTS.md non-negotiable #7).
const brainsConfig = (() => {
  try {
    return loadProfiles();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`[cockpit] profiles error: ${err.message}`);
      console.error(`[cockpit] ${err.hint}`);
      process.exit(1);
    }
    throw err;
  }
})();
for (const v of brainsConfig.ignoredLegacyVars) {
  console.warn(
    `[cockpit] ${v} is set but COCKPIT_PROFILES_FILE wins — the legacy value is ignored`,
  );
}

const verifier = new TokenVerifier({
  base: cfg.cockpitToken,
  admin: cfg.adminToken,
});

// 0.5.2 inbox relief state (cockpit-own, never the brain DB): path rules —
// explicit env wins, else alongside the profiles file (release-safe), else
// ~/.cockpit/ (never the cwd — that IS the release dir on managed hosts).
const inboxStore = createInboxStateStore({
  file: process.env.COCKPIT_INBOX_STATE_FILE,
  profilesFile: process.env.COCKPIT_PROFILES_FILE,
});

// Static web root: explicit env wins (compiled-binary deployments), then the
// repo checkout layout; absent both (dev loop via vite) static stays off.
function resolveDistRoot(): string | null {
  const explicit = process.env.COCKPIT_DIST_DIR?.trim();
  if (explicit) return explicit;
  const repoLayout = new URL("../../web/dist", import.meta.url).pathname;
  if (existsSync(repoLayout)) return repoLayout;
  return null;
}
const distRoot = resolveDistRoot();

const registry = await BrainRegistry.create(brainsConfig);

// The audit trail must be writable before anything is adjudicated or issued
// (0.7): a cockpit that cannot record who did what says so at boot.
try {
  await ensureAuditWritable();
} catch (err) {
  console.error(`[cockpit] audit trail is not writable: ${(err as Error).message}`);
  console.error("[cockpit] fix the permissions on ~/.cockpit-audit (owned by the service user, mode 700) and start again");
  process.exit(1);
}

// Named-token registry (0.7): off unless COCKPIT_TOKENS_FILE names it. Load
// failures are fatal (ConfigError) — a registry this code cannot understand
// is never treated as "empty". Management mutations are audited BEFORE the
// registry changes, by the admin actor.
const tokens = cfg.tokensFile
  ? TokenRegistry.load(cfg.tokensFile, {
      knownBrains: () => new Set(registry.profileIds()),
      auditStrict: (action, detail) => auditWriteStrict(OWNER_ADMIN, { action, detail }),
      auditSoft: async (action, detail) => {
        await auditWrite(OWNER_ADMIN, { action, detail });
      },
    })
  : null;

// Startup banner: one line per profile, availability only.
for (const p of brainsConfig.profiles) {
  const ch = registry.resolve(p.id)!;
  console.log(
    `[cockpit] profile ${p.id} (${p.name}) mcp:ok cli:${ch.cliBinResolved ?? "-"} pg:${p.pgReadonlyDsn ? "set" : "unset"}`,
  );
}
if (brainsConfig.mode === "legacy-env") {
  const legacy = brainsConfig.profiles[0]!;
  console.log(`[cockpit] gbrain MCP endpoint: ${legacy.mcpUrl}`);
  console.log(
    registry.resolve(legacy.id)?.cli
      ? `[cockpit] CLI channel: ${registry.resolve(legacy.id)?.cliBinResolved} (availability probed on first use)`
      : "[cockpit] CLI channel: no gbrain binary — adjudication actions degrade to copy-command",
  );
  if (!legacy.takesHolders) {
    console.log(
      "[cockpit] note: GBRAIN_TAKES_HOLDERS is unset — takes queues may look empty if the token was minted with default holders (see .env.example)",
    );
  }
} else {
  console.log(
    `[cockpit] ${brainsConfig.profiles.length} brain profile(s) from COCKPIT_PROFILES_FILE — switch with the x-brain-profile header`,
  );
}
if (tokens) {
  const rows = tokens.list();
  console.log(
    `[cockpit] named-token registry: ${cfg.tokensFile} (${rows.filter((t) => t.revokedAt === null).length} active, ${rows.filter((t) => t.revokedAt !== null).length} revoked)`,
  );
  for (const brain of tokens.unknownBrains()) {
    console.warn(
      `[cockpit] named-token registry: a token names brain "${brain}", which is not in brains.json — requests for it answer 403`,
    );
  }
}
console.log(
  `[cockpit] write origins: ${cfg.allowedOrigins.length > 0 ? cfg.allowedOrigins.join(", ") : "Origin must equal Host (COCKPIT_ALLOWED_ORIGINS unset)"}`,
);

const routeDeps: RouteDeps = { cfg, verifier, registry, tokens, inboxStore };

const server = Bun.serve({
  hostname: cfg.bind,
  port: cfg.port,
  // Never the development error page: it echoes the error message (DSNs
  // included), the stack and the working directory to the caller.
  development: false,
  async fetch(req): Promise<Response> {
    try {
      // inside the try on purpose: a Host the URL parser cannot take must
      // answer the JSON envelope, not a runtime default page
      const url = new URL(req.url);
      // Coarse, unauthenticated health for uptime pollers — statuses only.
      // Reflects the DEFAULT profile (documented: uptime semantics stay
      // stable regardless of which brain the UI is looking at).
      if (url.pathname === "/healthz") {
        if (req.method !== "GET") {
          return envelope(405, "E_METHOD_NOT_ALLOWED" as ErrorCode, "only GET is allowed");
        }
        const def = registry.resolve(null);
        return withApiHeaders(Response.json(toCoarse(await getHealthReport(def!))));
      }

      const rejected = guardRequest(req, url, cfg);
      if (rejected) return rejected;

      if (url.pathname.startsWith("/api/")) {
        return await handleApi(req, url, routeDeps);
      }

      // Static web app (production form): the built SPA from web/dist.
      if (req.method === "GET" && distRoot) {
        return await serveStatic(distRoot, url.pathname);
      }

      return envelope(404, "E_NOT_FOUND", "unknown route");
    } catch (err) {
      // ONE catch-all for the whole request path (the gate included): an
      // unexpected throw answers the JSON envelope, never Bun's error page.
      return mapError(err);
    }
  },
  // errors Bun itself raises below the fetch layer get the same envelope
  error(err): Response {
    return mapError(err);
  },
});

console.log(`[cockpit] v${COCKPIT_VERSION} listening on http://${cfg.bind}:${cfg.port}`);
console.log(`[cockpit] inbox relief state: ${inboxStore.path} (one file per server; cockpit-owned, never the brain DB)`);
console.log(
  tokens
    ? "[cockpit] auth: /api/* takes 'Authorization: Bearer <token>' — the env tokens or a named token from the registry"
    : "[cockpit] auth: /api/* requires 'Authorization: Bearer <COCKPIT_TOKEN>' (named tokens off — COCKPIT_TOKENS_FILE unset)",
);
console.log(
  verifier.adminConfigured
    ? "[cockpit] auth: management writes, the paid model probe and token management require the COCKPIT_ADMIN_TOKEN tier"
    : "[cockpit] auth: COCKPIT_ADMIN_TOKEN unset — management writes and the paid model probe answer 403 and degrade to copy-commands",
);

// After the listener is up (a boot loop must not flood the trail).
if (tokens) {
  const rows = tokens.list();
  try {
    await auditWriteStrict(OWNER_ADMIN, {
      action: "registry.loaded",
      detail: {
        active: rows.filter((t) => t.revokedAt === null).length,
        revoked: rows.filter((t) => t.revokedAt !== null).length,
      },
    });
  } catch (err) {
    console.error(`[audit] registry.loaded line not written: ${(err as Error).message}`);
  }
}

function shutdown(): void {
  console.log("[cockpit] shutting down");
  tokens?.dispose();
  server.stop(true);
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
