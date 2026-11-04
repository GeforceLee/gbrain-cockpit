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
