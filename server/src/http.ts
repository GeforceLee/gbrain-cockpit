import type { ErrorEnvelope, ErrorCode, PermissionMissing } from "@gbrain-cockpit/shared";
import type { Config } from "./config";
import { hasTokenInQuery } from "./auth";

// Per-request defenses (ARCHITECTURE §5-3/4): token never in query, Host
// whitelist (DNS-rebinding), Origin check on state-changing requests
// (cross-site writes), and JSON-only write bodies (text/plain CSRF bypass).
// Returns a Response when the request must be rejected, null when it passes.
//
// 0.7 additions for multi-user deployments: the Origin check also accepts
// the operator's COCKPIT_ALLOWED_ORIGINS (a proxy that rewrites Host makes
// "Origin equals Host" refuse every browser write); every response carries
// the anti-framing + nosniff headers; API responses are never cached; and
// request bodies are capped before they are read into memory.

/** Headers on every response: cockpit renders untrusted brain content and
 *  holds a bearer token in localStorage, so another site must not be able
 *  to frame it and overlay a click on an irreversible action. `self` keeps
 *  the door open for a same-origin host app. */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "content-security-policy": "frame-ancestors 'self'",
  "x-content-type-options": "nosniff",
};

/** API responses are per-caller (and the issue response holds a plaintext
 *  token once): no intermediary may store them. */
export const API_HEADERS: Readonly<Record<string, string>> = {
  ...SECURITY_HEADERS,
  "cache-control": "no-store",
};

export function envelope(
  status: number,
  code: ErrorCode,
  error: string,
  extraHeaders: Record<string, string> = {},
  extra: Pick<ErrorEnvelope, "missing" | "source"> = {},
): Response {
  const body: ErrorEnvelope = { error, code, ...extra };
  const headers: Record<string, string> = {
    "content-type": "application/json; charset=utf-8",
    ...API_HEADERS,
    ...extraHeaders,
  };
  if (status === 401) headers["www-authenticate"] = "Bearer";
  return new Response(JSON.stringify(body), { status, headers });
}

/** Copy `res` with the API headers added (existing headers win). */
export function withApiHeaders(res: Response): Response {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(API_HEADERS)) {
    if (!headers.has(k)) headers.set(k, v);
  }
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
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
    if (extra.includes(":")) {
      hosts.add(extra);
      continue;
    }
    // A portless entry is the operator naming a host reached on its default
    // port (https://cockpit.example.com sends `Host: cockpit.example.com`).
    // The port-appended spelling stays accepted so existing configs behave
    // exactly as before.
    hosts.add(extra);
    hosts.add(`${extra}:${cfg.port}`);
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
    if (origin !== null) {
      // Browsers send a serialised, canonical origin. Anything else is not
      // a browser origin claim, so it is refused rather than normalized —
      // that also tightens the old branch, which compared hosts only and so
      // let `http://127.0.0.1:<port>/anything` through.
      let u: URL;
      try {
        u = new URL(origin);
      } catch {
        return envelope(403, "E_BAD_REQUEST", "cross-origin write rejected");
      }
      if (u.origin !== origin || (u.host !== host && !cfg.allowedOrigins.includes(u.origin))) {
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

/** Request bodies are read whole before validation; the cap keeps a
 *  low-privilege caller from spending the process's memory. 8 MB leaves
 *  room for a 1 MB page plus JSON escaping. */
export const BODY_CAP_BYTES = 8 * 1024 * 1024;

export class PayloadTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`request body exceeds ${maxBytes} bytes`);
    this.name = "PayloadTooLargeError";
  }
}

export async function readJsonBody(
  req: Request,
  maxBytes = BODY_CAP_BYTES,
): Promise<Record<string, unknown>> {
  let text: string;
  try {
    text = await readTextCapped(req, maxBytes);
  } catch (err) {
    if (err instanceof PayloadTooLargeError) throw err;
    throw new BadRequestError(`invalid JSON body: ${(err as Error).message}`);
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("body must be a JSON object");
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    throw new BadRequestError(`invalid JSON body: ${(err as Error).message}`);
  }
}

async function readTextCapped(req: Request, maxBytes: number): Promise<string> {
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new PayloadTooLargeError(maxBytes);
  }
  const body = req.body;
  if (!body) return "";
  // Stream-counted: a chunked or lying Content-Length is caught here too.
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new PayloadTooLargeError(maxBytes);
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

export class BadRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BadRequestError";
  }
}
