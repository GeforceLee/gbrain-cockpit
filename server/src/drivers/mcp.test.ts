import { describe, expect, test } from "bun:test";
import { McpDriver, McpError } from "./mcp";

// The driver is tested against a fake fetch implementing the Streamable HTTP
// shapes gbrain serve actually produces: JSON bodies, optional SSE bodies,
// session header capture, 202 for notifications.

interface RecordedCall {
  body: string;
  headers: Record<string, string>;
}

function makeFakeFetch(handler: (call: RecordedCall) => Response) {
  const calls: RecordedCall[] = [];
  const fetchFn = (async (_url: unknown, init?: RequestInit) => {
    const call: RecordedCall = {
      body: String(init?.body ?? ""),
      headers: (init?.headers ?? {}) as Record<string, string>,
    };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;
  return { fetchFn, calls };
}

const jsonRes = (body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", ...headers },
  });

describe("McpDriver", () => {
  test("handshakes once, captures the session, and parses structured tool output", async () => {
    const { fetchFn, calls } = makeFakeFetch((call) => {
      const parsed = JSON.parse(call.body) as { method: string; id?: number };
      if (parsed.method === "initialize") {
        return jsonRes(
          { jsonrpc: "2.0", id: parsed.id, result: { protocolVersion: "2025-03-26" } },
          { "mcp-session-id": "sess-1" },
        );
      }
      if (parsed.method === "notifications/initialized") {
        return new Response(null, { status: 202 });
      }
      if (parsed.method === "tools/call") {
        // Session id from the handshake must be replayed.
        expect(call.headers["mcp-session-id"]).toBe("sess-1");
        return jsonRes({
          jsonrpc: "2.0",
          id: parsed.id,
          result: {
            content: [{ type: "text", text: '{"transport":"bearer-legacy"}' }],
            structuredContent: { transport: "bearer-legacy", scopes: ["read"] },
          },
        });
      }
      throw new Error(`unexpected method ${parsed.method}`);
    });

    const driver = new McpDriver({
      url: "http://unit/mcp",
      token: "t",
      fetchFn,
    });
    const first = await driver.whoami();
    expect(first).toEqual({ transport: "bearer-legacy", scopes: ["read"] });
    await driver.whoami(); // second call reuses the session
    const initializes = calls.filter((c) =>
      c.body.includes('"initialize"'),
    ).length;
    expect(initializes).toBe(1);
  });

  test("falls back to parsing the first text part when no structuredContent", async () => {
    const { fetchFn } = makeFakeFetch((call) => {
      const parsed = JSON.parse(call.body) as { method: string; id?: number };
      if (parsed.method === "initialize") {
        return jsonRes({ jsonrpc: "2.0", id: parsed.id, result: {} });
      }
      if (parsed.method === "tools/call") {
        return jsonRes({
          jsonrpc: "2.0",
          id: parsed.id,
          result: {
            content: [{ type: "text", text: '{"name":"main","pages":12}' }],
          },
        });
      }
      return new Response(null, { status: 202 });
    });
    const driver = new McpDriver({ url: "http://unit/mcp", token: "t", fetchFn });
    expect(await driver.brainIdentity()).toEqual({ name: "main", pages: 12 });
  });

  test("parses SSE-encoded responses", async () => {
    const sseBody =
      ": keep-alive\n\ndata: {\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"content\":[{\"type\":\"text\",\"text\":\"[1,2]\"}]}}\n\n";
    const { fetchFn } = makeFakeFetch((call) => {
      const parsed = JSON.parse(call.body) as { method: string; id?: number };
      if (parsed.method === "initialize") {
        return jsonRes({ jsonrpc: "2.0", id: parsed.id, result: {} });
      }
      return new Response(sseBody, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    });
    const driver = new McpDriver({ url: "http://unit/mcp", token: "t", fetchFn });
    expect(await driver.callTool("whoami")).toEqual([1, 2]);
  });

  test("maps HTTP 401 to an auth error", async () => {
    const { fetchFn } = makeFakeFetch(() => new Response("unauthorized", { status: 401 }));
    const driver = new McpDriver({ url: "http://unit/mcp", token: "bad", fetchFn });
    try {
      await driver.whoami();
      throw new Error("expected McpError");
    } catch (err) {
      expect(err).toBeInstanceOf(McpError);
      expect((err as McpError).kind).toBe("auth");
    }
  });

  test("maps HTTP 429 to a rate-limit error carrying Retry-After", async () => {
    const { fetchFn } = makeFakeFetch(
      () => new Response("slow down", { status: 429, headers: { "retry-after": "3" } }),
    );
    const driver = new McpDriver({ url: "http://unit/mcp", token: "t", fetchFn });
    try {
      await driver.whoami();
      throw new Error("expected McpError");
    } catch (err) {
      const e = err as McpError;
      expect(e.kind).toBe("rate-limit");
      expect(e.retryAfterMs).toBe(3000);
    }
  });

  test("a failed handshake resets so the next call re-initializes", async () => {
    let failFirst = true;
    const { fetchFn } = makeFakeFetch((call) => {
      const parsed = JSON.parse(call.body) as { method: string; id?: number };
      if (parsed.method === "initialize") {
        if (failFirst) {
          failFirst = false;
          return new Response("boom", { status: 500 });
        }
        return jsonRes({ jsonrpc: "2.0", id: parsed.id, result: {} }, { "mcp-session-id": "s2" });
      }
      if (parsed.method === "tools/call") {
        expect(call.headers["mcp-session-id"]).toBe("s2");
        return jsonRes({
          jsonrpc: "2.0",
          id: parsed.id,
          result: { content: [{ type: "text", text: "{}" }] },
        });
      }
      return new Response(null, { status: 202 });
    });
    const driver = new McpDriver({ url: "http://unit/mcp", token: "t", fetchFn });
    await expect(driver.whoami()).rejects.toBeInstanceOf(McpError);
    await expect(driver.whoami()).resolves.toEqual({});
  });
});

describe("normalizeReceipt", () => {
  test("passes through known states", async () => {
    const { normalizeReceipt } = await import("./mcp");
    expect(normalizeReceipt({ status: "committed" }, "r1")).toMatchObject({
      request_id: "r1",
      status: "committed",
    });
    expect(normalizeReceipt({ status: "conflict" }, "r1").status).toBe("conflict");
    expect(
      normalizeReceipt({ write_request: { status: "queued" } }, "r1").status,
    ).toBe("queued");
  });

  test("immediate success without a state reads as committed", async () => {
    const { normalizeReceipt } = await import("./mcp");
    expect(normalizeReceipt({ ok: true }, "r1").status).toBe("committed");
  });

  test("unrecognized payloads stay unknown with detail", async () => {
    const { normalizeReceipt } = await import("./mcp");
    const receipt = normalizeReceipt({ weird: true }, "r1");
    expect(receipt.status).toBe("unknown");
    expect(receipt.detail).toContain("weird");
  });
});

// --- OAuth client_credentials (multi-brain profiles) -------------------------

interface Recorded {
  url: string;
  body: string;
  headers: Record<string, string>;
}

function urlAwareFetch(handler: (call: Recorded) => Response) {
  const calls: Recorded[] = [];
  const fetchFn = (async (input: unknown, init?: RequestInit) => {
    const call: Recorded = {
      url: String(input),
      body: String(init?.body ?? ""),
      headers: (init?.headers ?? {}) as Record<string, string>,
    };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;
  return { fetchFn, calls };
}

const oauthOpts = {
  url: "http://unit/mcp",
  oauth: {
    issuerUrl: "http://unit",
    clientId: "ci",
    clientSecret: "SUPER-SECRET",
    accessToken: "stale-token",
    expiresAt: Math.floor(Date.now() / 1000) - 10, // already expired
  },
} as const;

function mcpJsonRpc(call: Recorded): Response {
  const parsed = JSON.parse(call.body) as { method: string; id?: number };
  if (parsed.method === "initialize") {
    return jsonRes({ jsonrpc: "2.0", id: parsed.id, result: {} });
  }
  if (parsed.method === "tools/call") {
    return jsonRes({
      jsonrpc: "2.0",
      id: parsed.id,
      result: { content: [{ type: "text", text: '{"transport":"oauth"}' }] },
    });
  }
  return new Response(null, { status: 202 });
}

describe("McpDriver oauth renewal", () => {
  test("expired handoff token: renews via client_credentials POST before the call", async () => {
    const { fetchFn, calls } = urlAwareFetch((call) => {
      if (call.url === "http://unit/token") {
        expect(call.headers["content-type"]).toBe(
          "application/x-www-form-urlencoded",
        );
        expect(call.body).toContain("grant_type=client_credentials");
        expect(call.body).toContain("client_id=ci");
        return jsonRes({ access_token: "fresh-1", expires_in: 3600 });
      }
      expect(call.headers["authorization"]).toBe("Bearer fresh-1");
      return mcpJsonRpc(call);
    });
    const driver = new McpDriver({ ...oauthOpts, fetchFn });
    expect(await driver.whoami()).toEqual({ transport: "oauth" });
    const tokenPosts = calls.filter((c) => c.url === "http://unit/token");
    expect(tokenPosts).toHaveLength(1); // single-flight, not per-request
    await driver.whoami();
    expect(calls.filter((c) => c.url === "http://unit/token")).toHaveLength(1);
  });

  test("401 mid-session: one forced renewal, then a single replay", async () => {
    let renewed = false;
    let replayed = false;
    const { fetchFn, calls } = urlAwareFetch((call) => {
      if (call.url === "http://unit/token") {
        renewed = true;
        return jsonRes({ access_token: "fresh-2", expires_in: 3600 });
      }
      const auth = call.headers["authorization"];
      if (auth === "Bearer stale-token" && call.body.includes("tools/call")) {
        return new Response("invalid_token", { status: 401 });
      }
      if (auth === "Bearer fresh-2" && call.body.includes("tools/call")) {
        replayed = true;
        return mcpJsonRpc(call);
      }
      return mcpJsonRpc(call);
    });
    const driver = new McpDriver({ ...oauthOpts, fetchFn });
    expect(await driver.whoami()).toEqual({ transport: "oauth" });
    expect(renewed).toBe(true);
    expect(replayed).toBe(true);
    expect(calls.filter((c) => c.url === "http://unit/token")).toHaveLength(1);
  });

  test("renewal failures never leak the client secret", async () => {
    const { fetchFn } = urlAwareFetch((call) => {
      if (call.url === "http://unit/token") {
        return new Response("unauthorized: SUPER-SECRET echo", { status: 401 });
      }
      return mcpJsonRpc(call);
    });
    const driver = new McpDriver({ ...oauthOpts, fetchFn });
    try {
      await driver.whoami();
      throw new Error("expected McpError");
    } catch (err) {
      expect(err).toBeInstanceOf(McpError);
      const e = err as McpError;
      expect(e.kind).toBe("auth");
      expect(`${e.message}${e.retryAfterMs ?? ""}`).not.toContain("SUPER-SECRET");
      expect(e.message).toContain("HTTP 401");
    }
  });

  test("static tokens never hit the token endpoint", async () => {
    const { fetchFn, calls } = urlAwareFetch((call) => {
      if (call.url === "http://unit/token") {
        throw new Error("static driver must not renew");
      }
      expect(call.headers["authorization"]).toBe("Bearer static-tok");
      return mcpJsonRpc(call);
    });
    const driver = new McpDriver({
      url: "http://unit/mcp",
      token: "static-tok",
      fetchFn,
    });
    expect(await driver.whoami()).toEqual({ transport: "oauth" });
    expect(calls.every((c) => c.url !== "http://unit/token")).toBe(true);
  });
});

describe("McpDriver opError classification (agent contract v1)", () => {
  function errToolFetch(code: string, error: string) {
    const fetchFn = (async (_input: unknown, init?: RequestInit) => {
      const parsed = JSON.parse(String(init?.body ?? "{}")) as {
        method?: string;
        id?: number;
      };
      if (parsed.method === "initialize") {
        return jsonRes({ jsonrpc: "2.0", id: parsed.id, result: {} });
      }
      if (parsed.method === "tools/call") {
        return jsonRes({
          jsonrpc: "2.0",
          id: parsed.id,
          result: {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  error: code,
                  code,
                  message: "Requested source is outside your granted sources",
                  suggestion: "re-mint the grant",
                }),
              },
            ],
            isError: true,
          },
        });
      }
      return new Response(null, { status: 202 });
    }) as typeof fetch;
    return fetchFn;
  }

  test("permission_denied → kind 'denied' with the upstream message", async () => {
    const driver = new McpDriver({
      url: "http://unit/mcp",
      token: "t",
      fetchFn: errToolFetch("permission_denied", "permission_denied"),
    });
    try {
      await driver.search("x", "other-source");
      throw new Error("expected McpError");
    } catch (err) {
      const e = err as McpError;
      expect(e.kind).toBe("denied");
      expect(e.message).toContain("outside your granted sources");
    }
  });

  test("insufficient_scope classifies the same way; unknown_source maps to its own kind", async () => {
    const a = new McpDriver({
      url: "http://unit/mcp",
      token: "t",
      fetchFn: errToolFetch("insufficient_scope", "insufficient_scope"),
    });
    await expect(a.search("x")).rejects.toMatchObject({ kind: "denied" });
    const b = new McpDriver({
      url: "http://unit/mcp",
      token: "t",
      fetchFn: errToolFetch("unknown_source", "unknown_source"),
    });
    await expect(b.search("x")).rejects.toMatchObject({
      kind: "unknown-source",
    });
  });
});

describe("source params attach only when a source is picked", () => {
  function recordingFetch() {
    const bodies: Record<string, unknown>[] = [];
    const fetchFn = (async (_input: unknown, init?: RequestInit) => {
      const parsed = JSON.parse(String(init?.body ?? "{}")) as {
        method?: string;
        id?: number;
        params?: { arguments?: Record<string, unknown> };
      };
      if (parsed.method === "initialize") {
        return jsonRes({ jsonrpc: "2.0", id: parsed.id, result: {} });
      }
      if (parsed.method === "tools/call") {
        bodies.push(parsed.params?.arguments ?? {});
        return jsonRes({
          jsonrpc: "2.0",
          id: parsed.id,
          result: { content: [{ type: "text", text: "[]" }] },
        });
      }
      return new Response(null, { status: 202 });
    }) as typeof fetch;
    return { fetchFn, bodies };
  }

  test("no source → byte-identical args for older gbrains", async () => {
    const { fetchFn, bodies } = recordingFetch();
    const driver = new McpDriver({ url: "http://u/mcp", token: "t", fetchFn });
    await driver.getPage("a");
    await driver.search("q");
    await driver.listPages({ limit: 50 });
    expect(bodies[0]).toEqual({ slug: "a", include_content: true });
    expect(bodies[1]).toEqual({ query: "q" });
    expect(bodies[2]).toEqual({ limit: 50 });
  });

  test("picked source → attached to get_page / search / list_pages; cache keys split", async () => {
    const { fetchFn, bodies } = recordingFetch();
    const driver = new McpDriver({ url: "http://u/mcp", token: "t", fetchFn });
    await driver.getPage("a", "main");
    await driver.search("q", "main");
    await driver.listPages({ limit: 50, sourceId: "main" });
    // same args again hit the TTL cache (no new tool calls)
    await driver.getPage("a", "main");
    expect(bodies).toHaveLength(3);
    expect(bodies[0]).toEqual({ slug: "a", include_content: true, source_id: "main" });
    expect(bodies[1]).toEqual({ query: "q", source_id: "main" });
    expect(bodies[2]).toEqual({ limit: 50, source_id: "main" });
    // a different source is a different cache entry → a real new call
    await driver.getPage("a", "archive");
    expect(bodies).toHaveLength(4);
    expect(bodies[3]).toEqual({ slug: "a", include_content: true, source_id: "archive" });
  });
});

// --- V1.1 provenance wrappers (live-probed shapes, 2026-11-06) -----------------

describe("V1.1 provenance wrapper arg shapes", () => {
  /** Fetch stub answering every tools/call with `result` and recording
   *  {tool, args} so assertions can pin exact wire shapes. */
  function respondingFetch(result: unknown) {
    const calls: Array<{ tool?: string; args?: Record<string, unknown> }> = [];
    const fetchFn = (async (_input: unknown, init?: RequestInit) => {
      const parsed = JSON.parse(String(init?.body ?? "{}")) as {
        method?: string;
        id?: number;
        params?: { name?: string; arguments?: Record<string, unknown> };
      };
      if (parsed.method === "initialize") {
        return jsonRes({ jsonrpc: "2.0", id: parsed.id, result: {} });
      }
      if (parsed.method === "tools/call") {
        calls.push({ tool: parsed.params?.name, args: parsed.params?.arguments ?? {} });
        return jsonRes({
          jsonrpc: "2.0",
          id: parsed.id,
          result: { content: [{ type: "text", text: JSON.stringify(result) }] },
        });
      }
      return new Response(null, { status: 202 });
    }) as typeof fetch;
    return { fetchFn, calls };
  }

  test("getLinks/getBacklinks: slug always, source_id attach-only", async () => {
    const { fetchFn, calls } = respondingFetch([]);
    const driver = new McpDriver({ url: "http://u/mcp", token: "t", fetchFn });
    await driver.getLinks("a");
    await driver.getLinks("a", "main");
    await driver.getBacklinks("a", "main");
    expect(calls[0]).toEqual({ tool: "get_links", args: { slug: "a" } });
    expect(calls[1]).toEqual({ tool: "get_links", args: { slug: "a", source_id: "main" } });
    expect(calls[2]).toEqual({ tool: "get_backlinks", args: { slug: "a", source_id: "main" } });
  });

  test("getTimeline: bare slug only", async () => {
    const { fetchFn, calls } = respondingFetch([]);
    const driver = new McpDriver({ url: "http://u/mcp", token: "t", fetchFn });
    await driver.getTimeline("a");
    expect(calls[0]).toEqual({ tool: "get_timeline", args: { slug: "a" } });
  });

  test("listPages slugPrefix/tag map to snake_case wire params", async () => {
    const { fetchFn, calls } = respondingFetch([]);
    const driver = new McpDriver({ url: "http://u/mcp", token: "t", fetchFn });
    await driver.listPages({ limit: 50, slugPrefix: "kb/", tag: "follow-up" });
    expect(calls[0]).toEqual({
      tool: "list_pages",
      args: { limit: 50, slug_prefix: "kb/", tag: "follow-up" },
    });
  });

  test("listWriteRequests/listWriteConflicts unwrap their envelopes", async () => {
    const { fetchFn, calls } = respondingFetch({
      requests: [{ request_id: "r-1", status: "committed" }],
      conflicts: [{ slug: "a" }],
    });
    const driver = new McpDriver({ url: "http://u/mcp", token: "t", fetchFn });
    const reqs = await driver.listWriteRequests({ sourceId: "main", limit: 50 });
    const conflicts = await driver.listWriteConflicts({ sourceId: "main" });
    expect(calls[0]).toEqual({
      tool: "list_write_requests",
      args: { source_id: "main", limit: 50 },
    });
    expect(calls[1]).toEqual({
      tool: "list_write_conflicts",
      args: { source_id: "main" },
    });
    expect(reqs[0]!.request_id).toBe("r-1");
    expect(conflicts[0]!.slug).toBe("a");
  });

  test("sourcesStatus sends {id} — the probed arg name, NOT source_id", async () => {
    const { fetchFn, calls } = respondingFetch({ id: "main", clone_state: "healthy" });
    const driver = new McpDriver({ url: "http://u/mcp", token: "t", fetchFn });
    const diag = await driver.sourcesStatus("main");
    expect(calls[0]).toEqual({ tool: "sources_status", args: { id: "main" } });
    expect(diag.clone_state).toBe("healthy");
  });

  test("assembleEvidence maps triples + optional return_unit", async () => {
    const { fetchFn, calls } = respondingFetch({ results: [], unresolved: [] });
    const driver = new McpDriver({ url: "http://u/mcp", token: "t", fetchFn });
    await driver.assembleEvidence([{ sourceId: "main", slug: "a", chunkId: 1481 }]);
    await driver.assembleEvidence(
      [{ sourceId: "main", slug: "a", chunkId: 1481 }],
      { returnUnit: "window" },
    );
    expect(calls[0]).toEqual({
      tool: "assemble_evidence",
      args: { hits: [{ source_id: "main", slug: "a", chunk_id: 1481 }] },
    });
    expect(calls[1]).toEqual({
      tool: "assemble_evidence",
      args: {
        hits: [{ source_id: "main", slug: "a", chunk_id: 1481 }],
        return_unit: "window",
      },
    });
  });
});
