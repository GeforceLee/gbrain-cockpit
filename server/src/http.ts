import type { ErrorEnvelope, ErrorCode } from "@gbrain-cockpit/shared";
import type { Config } from "./config";
import { hasTokenInQuery } from "./auth";

// Per-request defenses (ARCHITECTURE §5-3/4): token never in query, Host
// whitelist (DNS-rebinding), Origin check on state-changing requests
// (cross-site writes), and JSON-only write bodies (text/plain CSRF bypass).
// Returns a Response when the request must be rejected, null when it passes.

export function envelope(
  status: number,
  code: ErrorCode,
  error: string,
  extraHeaders: Record<string, string> = {},
): Response {
  const body: ErrorEnvelope = { error, code };
  const headers: Record<string, string> = {
    "content-type": "application/json; charset=utf-8",
    ...extraHeaders,
  };
  if (status === 401) headers["www-authenticate"] = "Bearer";
  return new Response(JSON.stringify(body), { status, headers });
}

export function allowedHosts(cfg: Config): Set<string> {
  const hosts = new Set<string>([
    `127.0.0.1:${cfg.port}`,
    `localhost:${cfg.port}`,
    `[::1]:${cfg.port}`,
    `${cfg.bind}:${cfg.port}`,
  ]);
  for (const extra of (process.env.COCKPIT_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean)) {
    hosts.add(extra.includes(":") ? extra : `${extra}:${cfg.port}`);
  }
  return hosts;
}

export function guardRequest(
  req: Request,
  url: URL,
  cfg: Config,
): Response | null {
  if (hasTokenInQuery(url)) {
    return envelope(
      400,
      "E_BAD_REQUEST",
      "tokens must travel in the Authorization header, never in the query string",
    );
  }

  const host = req.headers.get("host");
  if (!host || !allowedHosts(cfg).has(host)) {
    return envelope(400, "E_BAD_REQUEST", "unrecognized Host header");
  }

  if (req.method !== "GET") {
    const origin = req.headers.get("origin");
    if (origin) {
      let originHost: string | null = null;
      try {
        originHost = new URL(origin).host;
      } catch {
        originHost = null;
      }
      if (!originHost || originHost !== host) {
        return envelope(403, "E_BAD_REQUEST", "cross-origin write rejected");
      }
    }
    const contentType = req.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().includes("application/json")) {
      return envelope(
        415,
        "E_BAD_REQUEST",
        "write requests must carry application/json",
      );
    }
  }

  return null;
}

export async function readJsonBody(
  req: Request,
): Promise<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(await req.text()) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("body must be a JSON object");
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    throw new BadRequestError(`invalid JSON body: ${(err as Error).message}`);
  }
}

export class BadRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BadRequestError";
  }
}
