import type { ErrorCode } from "@gbrain-cockpit/shared";
import { COCKPIT_VERSION } from "@gbrain-cockpit/shared";
import { existsSync } from "node:fs";
import { TokenVerifier } from "./auth";
import { loadConfig, ConfigError, type Config } from "./config";
import { locateGbrainBin, CliDriver } from "./drivers/cli";
import { McpDriver } from "./drivers/mcp";
import { PgReadonlyDriver } from "./drivers/pg-readonly";
import { loadRootEnv } from "./env";
import { envelope, guardRequest } from "./http";
import { serveStatic } from "./static";
import {
  handleConfirm,
  handleEdgeAction,
  handleGraph,
  handleInbox,
  handlePage,
  handlePageFacets,
  handlePageWrite,
  handlePages,
  handleSearch,
  handleTakePropose,
  handleTrustDrop,
  handleWriteRequest,
  mapError,
  type ApiContext,
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

const verifier = new TokenVerifier(cfg.cockpitToken);
const mcp = new McpDriver({ url: cfg.gbrainMcpUrl, token: cfg.gbrainMcpToken });

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

const gbrainBin = await locateGbrainBin(cfg.gbrainBin);
const cli = gbrainBin ? new CliDriver(gbrainBin) : null;
if (cfg.gbrainBin && !gbrainBin) {
  console.error(`[cockpit] GBRAIN_BIN is set but not executable: ${cfg.gbrainBin}`);
  process.exit(1);
}

// Read-only graph bypass: optional channel — unset DSN (PGLite engines)
// simply means Nebula reports "down"; never fatal (ARCHITECTURE §3.3, §11-3).
const pg = new PgReadonlyDriver({ dsn: cfg.pgReadonlyDsn });
if (cfg.pgReadonlyDsn) {
  try {
    const latency = await pg.ping();
    console.log(`[cockpit] graph bypass: read-only Postgres reachable (${latency}ms)`);
  } catch (err) {
    console.warn(
      `[cockpit] graph bypass: Postgres probe failed — Nebula degrades to cached/stale (${err instanceof Error ? err.message : String(err)})`,
    );
  }
} else {
  console.log("[cockpit] graph bypass: PG_READONLY_DSN unset — Nebula will report the channel as down");
}

const api: ApiContext = { mcp, cli, pg };

const server = Bun.serve({
  hostname: cfg.bind,
  port: cfg.port,
  async fetch(req): Promise<Response> {
    const url = new URL(req.url);

    // Coarse, unauthenticated health for uptime pollers — statuses only.
    if (url.pathname === "/healthz") {
      if (req.method !== "GET") {
        return envelope(405, "E_METHOD_NOT_ALLOWED" as ErrorCode, "only GET is allowed");
      }
      return Response.json(toCoarse(await getHealthReport(cfg, mcp, pg)));
    }

    const rejected = guardRequest(req, url, cfg);
    if (rejected) return rejected;

    if (url.pathname.startsWith("/api/")) {
      const principal = verifier.verify(req.headers.get("authorization"));
      if (!principal) {
        return envelope(401, "E_UNAUTHENTICATED", "missing or invalid bearer token");
      }

      const route = `${req.method} ${url.pathname}`;
      try {
        switch (route) {
          case "GET /api/healthz":
            return Response.json(await getHealthReport(cfg, mcp, pg));
          case "GET /api/graph":
            return await handleGraph(api);
          case "GET /api/pages":
            return await handlePages(api, url);
          case "GET /api/pages/facets":
            return await handlePageFacets(api);
          case "GET /api/page":
            return await handlePage(api, url);
          case "GET /api/search":
            return await handleSearch(api, url);
          case "GET /api/inbox":
            return await handleInbox(api);
          case "POST /api/inbox/trust/drop":
            return await handleTrustDrop(api, req);
          case "POST /api/inbox/edge":
            return await handleEdgeAction(api, req);
          case "POST /api/inbox/takes/propose":
            return await handleTakePropose(api, req);
          case "POST /api/inbox/confirm":
            return await handleConfirm(api, req);
          case "PUT /api/page":
            return await handlePageWrite(api, req);
          case "GET /api/write-request":
            return await handleWriteRequest(api, url);
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
console.log(`[cockpit] gbrain MCP endpoint: ${cfg.gbrainMcpUrl}`);
console.log(
  cli
    ? `[cockpit] CLI channel: ${gbrainBin} (availability probed on first use)`
    : "[cockpit] CLI channel: no gbrain binary — adjudication actions degrade to copy-command",
);
if (cfg.gbrainTakesHolders === null) {
  console.log(
    "[cockpit] note: GBRAIN_TAKES_HOLDERS is unset — takes queues may look empty if the token was minted with default holders (see .env.example)",
  );
}

process.on("SIGINT", () => {
  console.log("[cockpit] shutting down");
  server.stop(true);
  process.exit(0);
});
process.on("SIGTERM", () => {
  server.stop(true);
  process.exit(0);
});
