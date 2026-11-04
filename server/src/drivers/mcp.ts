import {
  COCKPIT_VERSION,
  type BrainIdentity,
  type McpWhoami,
} from "@gbrain-cockpit/shared";

// Minimal MCP driver for the M0 skeleton: initialize handshake + tools/call
// against gbrain serve's Streamable HTTP endpoint, used by /healthz canary
// probes (whoami, get_brain_identity). The full driver (read/write/receipt
// polling, rate-limit budget, caching — ARCHITECTURE §3.1) lands in V1.0; the
// JSON-RPC plumbing here is written to be kept, not thrown away.

export type McpErrorKind =
  | "auth"
  | "rate-limit"
  | "timeout"
  | "http"
  | "protocol"
  | "network";

export class McpError extends Error {
  constructor(
    readonly kind: McpErrorKind,
    message: string,
    readonly status?: number,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "McpError";
  }
}

interface RpcResponse {
  result?: unknown;
  error?: { code: number; message: string };
}

interface ToolCallPayload {
  content?: Array<{ type: string; text?: string }>;
  structuredContent?: unknown;
  isError?: boolean;
}

const PROTOCOL_VERSION = "2025-03-26";

export interface McpDriverOptions {
  url: string;
  token: string;
  /** Driver-layer timeout is the single timeout authority (ARCHITECTURE §6). */
  timeoutMs?: number;
  /** Injectable for tests. */
  fetchFn?: typeof fetch;
}

export class McpDriver {
  readonly #url: string;
  readonly #token: string;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;
  #nextId = 0;
  #sessionId: string | null = null;
  #initPromise: Promise<void> | null = null;

  constructor(opts: McpDriverOptions) {
    this.#url = opts.url;
    this.#token = opts.token;
    this.#timeoutMs = opts.timeoutMs ?? 15_000;
    this.#fetch = opts.fetchFn ?? fetch;
  }

  /** Call an MCP tool and return its parsed payload. */
  async callTool<T = unknown>(
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<T> {
    await this.#ensureInitialized();
    const payload = (await this.#rpc("tools/call", {
      name,
      arguments: args,
    })) as ToolCallPayload | null;
    if (!payload) {
      throw new McpError("protocol", `tools/call ${name} returned no payload`);
    }
    if (payload.isError) {
      const text = payload.content
        ?.map((c) => c.text ?? "")
        .join("\n")
        .trim();
      throw new McpError("protocol", `tool ${name} errored: ${text || "n/a"}`);
    }
    // Prefer the structured payload; fall back to parsing the first text part.
    if (payload.structuredContent !== undefined) {
      return payload.structuredContent as T;
    }
    const text = payload.content?.find((c) => c.type === "text")?.text;
    if (text === undefined) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      return text as T;
    }
  }

  async whoami(): Promise<McpWhoami> {
    return this.callTool<McpWhoami>("whoami");
  }

  async brainIdentity(): Promise<BrainIdentity> {
    return this.callTool<BrainIdentity>("get_brain_identity");
  }

  async #ensureInitialized(): Promise<void> {
    // Lazily initialize once per session; a failed handshake resets so the
    // next call retries (gbrain restarts shouldn't wedge the driver until
    // process restart).
    this.#initPromise ??= (async () => {
      await this.#rpc("initialize", {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "gbrain-cockpit", version: COCKPIT_VERSION },
      });
      // Notification per spec — no id, no response body expected.
      await this.#post({
        jsonrpc: "2.0",
        method: "notifications/initialized",
      }).catch(() => {
        // Some servers fold this into the session already; a failed
        // notification is not fatal for our single-shot call pattern.
      });
    })();
    try {
      await this.#initPromise;
    } catch (err) {
      this.#initPromise = null;
      // A stale session id is the most common restart artifact — drop it so
      // the retry performs a fresh handshake.
      this.#sessionId = null;
      throw err;
    }
  }

  async #rpc(method: string, params?: object): Promise<unknown> {
    const id = ++this.#nextId;
    const { json } = await this.#post({
      jsonrpc: "2.0",
      id,
      method,
      ...(params ? { params } : {}),
    });
    if (!json) {
      throw new McpError(
        "protocol",
        `no JSON-RPC response for ${method} (HTTP body empty)`,
      );
    }
    if (json.error) {
      throw new McpError(
        "protocol",
        `${method} failed: ${json.error.message} (code ${json.error.code})`,
      );
    }
    return json.result;
  }

  async #post(body: object): Promise<{ json: RpcResponse | null }> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      // Streamable HTTP servers may answer JSON or SSE per request.
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${this.#token}`,
    };
    if (this.#sessionId) headers["mcp-session-id"] = this.#sessionId;

    let res: Response;
    try {
      res = await this.#fetch(this.#url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (err) {
      const name = (err as Error)?.name;
      if (name === "TimeoutError" || name === "AbortError") {
        throw new McpError(
          "timeout",
          `MCP request timed out after ${this.#timeoutMs}ms (gbrain dreaming? see ARCHITECTURE §3.4)`,
        );
      }
      throw new McpError(
        "network",
        `cannot reach gbrain MCP endpoint: ${(err as Error).message}`,
      );
    }

    if (res.status === 401 || res.status === 403) {
      throw new McpError(
        "auth",
        `gbrain rejected the cockpit token (HTTP ${res.status})`,
        res.status,
      );
    }
    if (res.status === 429) {
      const retryAfter = Number(res.headers.get("retry-after"));
      throw new McpError(
        "rate-limit",
        "gbrain is rate-limiting us (HTTP 429) — respecting Retry-After",
        429,
        Number.isFinite(retryAfter) ? retryAfter * 1000 : undefined,
      );
    }
    if (!res.ok) {
      throw new McpError("http", `unexpected HTTP ${res.status}`, res.status);
    }

    const sessionId = res.headers.get("mcp-session-id");
    if (sessionId) this.#sessionId = sessionId;

    // 202 = notification accepted, no body.
    if (res.status === 202) return { json: null };

    const contentType = res.headers.get("content-type") ?? "";
    const text = await res.text();
    if (contentType.includes("text/event-stream")) {
      return { json: parseSsePayload(text) };
    }
    if (!text) return { json: null };
    try {
      return { json: JSON.parse(text) as RpcResponse };
    } catch {
      throw new McpError(
        "protocol",
        `MCP endpoint returned a non-JSON body (content-type ${contentType || "unknown"})`,
      );
    }
  }
}

/** Extract the JSON-RPC response object from an SSE stream body. */
function parseSsePayload(text: string): RpcResponse | null {
  let last: RpcResponse | null = null;
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data) continue;
    try {
      const parsed = JSON.parse(data) as RpcResponse;
      if ("result" in parsed || "error" in parsed) last = parsed;
    } catch {
      // Keep-alive comments and non-JSON events are skipped.
    }
  }
  return last;
}
