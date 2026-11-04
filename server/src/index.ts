import type { ErrorEnvelope, ErrorCode } from "@gbrain-cockpit/shared";
import { COCKPIT_VERSION } from "@gbrain-cockpit/shared";
import { TokenVerifier, hasTokenInQuery } from "./auth";
import { loadConfig, ConfigError, type Config } from "./config";
import { loadRootEnv } from "./env";
import { McpDriver } from "./drivers/mcp";
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

function envelope(status: number, code: ErrorCode, error: string): Response {
  const body: ErrorEnvelope = { error, code };
  const headers: Record<string, string> = {
    "content-type": "application/json; charset=utf-8",
  };
  if (status === 401) headers["www-authenticate"] = "Bearer";
  return new Response(JSON.stringify(body), { status, headers });
}

const server = Bun.serve({
  hostname: cfg.bind,
  port: cfg.port,
  async fetch(req): Promise<Response> {
    const url = new URL(req.url);

    // Tokens in the query string are rejected outright — they leak into
    // access logs and Referer headers (ARCHITECTURE §5-3).
    if (hasTokenInQuery(url)) {
      return envelope(
        400,
        "E_BAD_REQUEST",
        "tokens must travel in the Authorization header, never in the query string",
      );
    }

    if (url.pathname === "/healthz") {
      if (req.method !== "GET") {
        return envelope(405, "E_METHOD_NOT_ALLOWED", "only GET is allowed");
      }
      // Coarse, unauthenticated: for uptime pollers. Statuses only.
      return Response.json(toCoarse(await getHealthReport(cfg, mcp)));
    }

    if (url.pathname === "/api/healthz") {
      if (req.method !== "GET") {
        return envelope(405, "E_METHOD_NOT_ALLOWED", "only GET is allowed");
      }
      const principal = verifier.verify(req.headers.get("authorization"));
      if (!principal) {
        return envelope(
          401,
          "E_UNAUTHENTICATED",
          "missing or invalid bearer token",
        );
      }
      return Response.json(await getHealthReport(cfg, mcp));
    }

    return envelope(404, "E_NOT_FOUND", "unknown route");
  },
});

console.log(`[cockpit] v${COCKPIT_VERSION} listening on http://${cfg.bind}:${cfg.port}`);
console.log("[cockpit] auth: /api/* requires 'Authorization: Bearer <COCKPIT_TOKEN>'");
console.log(`[cockpit] gbrain MCP endpoint: ${cfg.gbrainMcpUrl}`);
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
