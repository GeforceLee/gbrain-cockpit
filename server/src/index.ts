import { PROFILE_ID_RE, type ErrorCode } from "@gbrain-cockpit/shared";
import { COCKPIT_VERSION } from "@gbrain-cockpit/shared";
import { existsSync } from "node:fs";
import { TokenVerifier } from "./auth";
import { BrainRegistry } from "./brains";
import { loadConfig, ConfigError, type Config } from "./config";
import { loadRootEnv } from "./env";
import { envelope, guardRequest } from "./http";
import { loadProfiles } from "./profiles";
import { serveStatic } from "./static";
import {
  handleAnomalies,
  handleAuditHistory,
  handleBrainHealth,
  handleConfirm,
  handleContradictionAction,
  handleEdgeAction,
  handleEvidence,
  handleGraph,
  handleInbox,
  handlePage,
  handlePageFacets,
  handlePageWrite,
  handlePages,
  handleProfiles,
  handleSearch,
  handleSources,
  handleSourcesStatus,
  handleOpsSourceDrift,
  handleOpsClients,
  handleOpsDreamRuns,
  handleOpsGrantRead,
  handleOpsNightly,
  handleOpsCalibration,
  handleTakePropose,
  handleTakeResolve,
  handleTrustDrop,
  handleWriteCancel,
  handleWriteConflicts,
  handleWriteRequest,
  handleWriteRequests,
  handleResolveSlugs,
  mapError,
} from "./routes/api";
import { getHealthReport, toCoarse } from "./routes/health";

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

const server = Bun.serve({
  hostname: cfg.bind,
  port: cfg.port,
  async fetch(req): Promise<Response> {
    const url = new URL(req.url);

    // Coarse, unauthenticated health for uptime pollers — statuses only.
    // Reflects the DEFAULT profile (documented: uptime semantics stay
    // stable regardless of which brain the UI is looking at).
    if (url.pathname === "/healthz") {
      if (req.method !== "GET") {
        return envelope(405, "E_METHOD_NOT_ALLOWED" as ErrorCode, "only GET is allowed");
      }
      const def = registry.resolve(null);
      return Response.json(toCoarse(await getHealthReport(def!)));
    }

    const rejected = guardRequest(req, url, cfg);
    if (rejected) return rejected;

    if (url.pathname.startsWith("/api/")) {
      const principal = verifier.verify(req.headers.get("authorization"));
      if (!principal) {
        return envelope(401, "E_UNAUTHENTICATED", "missing or invalid bearer token");
      }

      // Profile routing: absent header = the default profile (0.1.1 curl
      // scripts and single-instance installs stay zero-aware); a malformed
      // or unknown id is a 400, never a silent fallback to the wrong brain.
      const profileId = req.headers.get("x-brain-profile");
      if (profileId !== null && !PROFILE_ID_RE.test(profileId)) {
        return envelope(400, "E_BAD_REQUEST", "invalid x-brain-profile header");
      }
      const channels = registry.resolve(profileId);
      if (!channels) {
        return envelope(400, "E_BAD_REQUEST", `unknown brain profile: ${profileId}`);
      }

      const route = `${req.method} ${url.pathname}`;
      try {
        switch (route) {
          case "GET /api/profiles":
            return await handleProfiles(registry, verifier.adminConfigured);
          case "GET /api/healthz":
            return Response.json(await getHealthReport(channels));
          case "GET /api/graph":
            return await handleGraph(channels);
          case "GET /api/pages":
            return await handlePages(channels, url);
          case "GET /api/pages/facets":
            return await handlePageFacets(channels, url);
          case "GET /api/page":
            return await handlePage(channels, url);
          case "GET /api/search":
            return await handleSearch(channels, url);
          case "GET /api/sources":
            return await handleSources(channels);
          case "GET /api/sources/status":
            return await handleSourcesStatus(channels);
          // 0.4.0 ops surface: reads on the base token, grant-read gated to
          // the admin tier inside the handler (two distinct 403 messages).
          case "GET /api/ops/sources-drift":
            return await handleOpsSourceDrift(channels);
          case "GET /api/ops/clients":
            return await handleOpsClients(channels);
          case "GET /api/ops/dream-runs":
            return await handleOpsDreamRuns(channels);
          // 0.5.0 nightly-cycle observability: reads on the base token
          // (perception is free; run-now actions stay copy-command)
          case "GET /api/ops/nightly":
            return await handleOpsNightly(channels);
          case "GET /api/ops/calibration":
            return await handleOpsCalibration(channels);
          case "POST /api/ops/grant-read": {
            const res = await handleOpsGrantRead(
              channels,
              principal,
              verifier.adminConfigured,
            );
            // derived whoami hints may change with the widened grant
            registry.invalidateProfileInfos();
            return res;
          }
          case "GET /api/inbox":
            return await handleInbox(channels);
          case "POST /api/inbox/trust/drop":
            return await handleTrustDrop(channels, req);
          case "POST /api/inbox/edge":
            return await handleEdgeAction(channels, req);
          case "POST /api/inbox/contradictions":
            return await handleContradictionAction(channels, req);
          case "POST /api/inbox/takes/propose":
            return await handleTakePropose(channels, req);
          case "POST /api/inbox/takes/resolve":
            return await handleTakeResolve(channels, req);
          case "POST /api/write-cancel":
            return await handleWriteCancel(channels, req);
          case "GET /api/resolve-slugs":
            return await handleResolveSlugs(channels, url);
          case "GET /api/brain-health":
            return await handleBrainHealth(channels);
          case "GET /api/anomalies":
            return await handleAnomalies(channels);
          case "GET /api/audit-history":
            return await handleAuditHistory(channels, url);
          case "POST /api/inbox/confirm":
            return await handleConfirm(channels, req);
          case "PUT /api/page":
            return await handlePageWrite(channels, req);
          case "GET /api/write-request":
            return await handleWriteRequest(channels, url);
          case "GET /api/write-requests":
            return await handleWriteRequests(channels, url);
          case "GET /api/write-conflicts":
            return await handleWriteConflicts(channels, url);
          case "POST /api/evidence":
            return await handleEvidence(channels, req);
          default:
            return envelope(404, "E_NOT_FOUND", "unknown route");
        }
      } catch (err) {
        return mapError(err);
      }
    }

    // Static web app (production form): the built SPA from web/dist.
    if (req.method === "GET" && distRoot) {
      return await serveStatic(distRoot, url.pathname);
    }

    return envelope(404, "E_NOT_FOUND", "unknown route");
  },
});

console.log(`[cockpit] v${COCKPIT_VERSION} listening on http://${cfg.bind}:${cfg.port}`);
console.log("[cockpit] auth: /api/* requires 'Authorization: Bearer <COCKPIT_TOKEN>'");
console.log(
  verifier.adminConfigured
    ? "[cockpit] auth: management writes require the COCKPIT_ADMIN_TOKEN tier"
    : "[cockpit] auth: COCKPIT_ADMIN_TOKEN unset — management writes answer 403 and degrade to copy-commands",
);

process.on("SIGINT", () => {
  console.log("[cockpit] shutting down");
  server.stop(true);
  process.exit(0);
});
process.on("SIGTERM", () => {
  server.stop(true);
  process.exit(0);
});
