import { describe, expect, test } from "bun:test";
import {
  API_HEADERS,
  PayloadTooLargeError,
  allowedHosts,
  envelope,
  guardRequest,
  readJsonBody,
  BadRequestError,
} from "./http";
import { loadConfig } from "./config";

const cfg = loadConfig({
  COCKPIT_TOKEN: "t",
  GBRAIN_MCP_TOKEN: "t",
  COCKPIT_PORT: "8787",
});

function req(
  path: string,
  init: { method?: string; origin?: string; contentType?: string; host?: string } = {},
): { req: Request; url: URL } {
  const headers: Record<string, string> = { host: init.host ?? "127.0.0.1:8787" };
  if (init.origin) headers.origin = init.origin;
  if (init.contentType) headers["content-type"] = init.contentType;
  const url = new URL(`http://127.0.0.1:8787${path}`);
  return {
    req: new Request(url, {
      method: init.method ?? "GET",
      headers,
      body: init.method && init.method !== "GET" ? "{}" : undefined,
    }),
    url,
  };
}

describe("guardRequest", () => {
  test("accepts plain local GET", () => {
    const { req: r, url } = req("/api/pages");
    expect(guardRequest(r, url, cfg)).toBeNull();
  });

  test("rejects token in query", () => {
    const { req: r, url } = req("/api/pages?token=abc");
    const res = guardRequest(r, url, cfg);
    expect(res?.status).toBe(400);
  });

  test("rejects unrecognized Host (DNS-rebinding guard)", () => {
    const { req: r, url } = req("/api/pages", { host: "evil.example:8787" });
    expect(guardRequest(r, url, cfg)?.status).toBe(400);
  });

  test("accepts configured Host variants", () => {
    for (const host of ["127.0.0.1:8787", "localhost:8787", "[::1]:8787"]) {
      const { req: r, url } = req("/api/pages", { host });
      expect(guardRequest(r, url, cfg)).toBeNull();
    }
  });

  test("rejects cross-origin writes", () => {
    const { req: r, url } = req("/api/inbox/edge", {
      method: "POST",
      origin: "http://evil.example",
      contentType: "application/json",
    });
    expect(guardRequest(r, url, cfg)?.status).toBe(403);
  });

  test("accepts same-origin JSON writes", () => {
    const { req: r, url } = req("/api/inbox/edge", {
      method: "POST",
      origin: "http://127.0.0.1:8787",
      contentType: "application/json",
    });
    expect(guardRequest(r, url, cfg)).toBeNull();
  });

  test("rejects non-JSON write bodies (text/plain CSRF bypass)", () => {
    const { req: r, url } = req("/api/inbox/edge", {
      method: "POST",
      contentType: "text/plain",
    });
    expect(guardRequest(r, url, cfg)?.status).toBe(415);
  });
});

describe("readJsonBody", () => {
  test("parses object bodies", async () => {
    const r = new Request("http://x/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"op":"accept"}',
    });
    expect(await readJsonBody(r)).toEqual({ op: "accept" });
  });

  test("rejects non-object and malformed bodies", async () => {
    for (const body of ["[1,2]", "null", "not json"]) {
      const r = new Request("http://x/", { method: "POST", body });
      await expect(readJsonBody(r)).rejects.toBeInstanceOf(BadRequestError);
    }
  });
});

// --- 0.7: origins behind a host-rewriting proxy, the body cap, response headers ---

describe("guardRequest with COCKPIT_ALLOWED_ORIGINS (0.7)", () => {
  const cfg = loadConfig({
    COCKPIT_TOKEN: "t",
    COCKPIT_ALLOWED_ORIGINS: "https://cockpit.example.com",
  });
  const post = (origin: string) =>
    guardRequest(
      new Request("http://127.0.0.1:8787/api/inbox/edge", {
        method: "POST",
        headers: { host: "127.0.0.1:8787", origin, "content-type": "application/json" },
        body: "{}",
      }),
      new URL("http://127.0.0.1:8787/api/inbox/edge"),
      cfg,
    );

  test("an origin on the list passes a write even though Host was rewritten", () => {
    expect(post("https://cockpit.example.com")).toBeNull();
  });

  test("everything else is still refused, in canonical form only", () => {
    for (const origin of [
      "https://evil.example",
      "https://cockpit.example.com/", // trailing slash
      "https://cockpit.example.com:443", // default port
      "https://Cockpit.example.com", // case
      "https://cockpit.example.com/api", // a path (the 0.6 check let this through)
      "https://cockpit.example.com.evil.example",
      "null",
      "https://user@cockpit.example.com",
    ]) {
      expect(post(origin)?.status).toBe(403);
    }
  });

  test("without a list the check is exactly the 0.6 one", () => {
    const plain = loadConfig({ COCKPIT_TOKEN: "t" });
    const res = guardRequest(
      new Request("http://127.0.0.1:8787/api/inbox/edge", {
        method: "POST",
        headers: {
          host: "127.0.0.1:8787",
          origin: "https://cockpit.example.com",
          "content-type": "application/json",
        },
        body: "{}",
      }),
      new URL("http://127.0.0.1:8787/api/inbox/edge"),
      plain,
    );
    expect(res?.status).toBe(403);
  });

  test("a portless Host entry is accepted with and without the port", () => {
    const previous = process.env.COCKPIT_ALLOWED_HOSTS;
    process.env.COCKPIT_ALLOWED_HOSTS = "cockpit.example.com";
    try {
      const hosts = allowedHosts(cfg);
      expect(hosts.has("cockpit.example.com")).toBe(true); // browsers on :443 send no port
      expect(hosts.has("cockpit.example.com:8787")).toBe(true); // the 0.6 spelling still works
      expect(hosts.has("127.0.0.1:8787")).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.COCKPIT_ALLOWED_HOSTS;
      else process.env.COCKPIT_ALLOWED_HOSTS = previous;
    }
  });
});

describe("request bodies are capped before they are read", () => {
  test("a declared Content-Length over the cap is refused unread", async () => {
    const req = new Request("http://x/", {
      method: "POST",
      headers: { "content-length": String(9 * 1024 * 1024), "content-type": "application/json" },
      body: "{}",
    });
    await expect(readJsonBody(req)).rejects.toBeInstanceOf(PayloadTooLargeError);
  });

  test("a body that grows past the cap while streaming is cut off", async () => {
    const big = JSON.stringify({ q: "x".repeat(5000) });
    const req = new Request("http://x/", { method: "POST", body: big });
    await expect(readJsonBody(req, 1024)).rejects.toBeInstanceOf(PayloadTooLargeError);
    // and the same body under a larger cap parses normally
    const ok = await readJsonBody(
      new Request("http://x/", { method: "POST", body: big }),
      64 * 1024,
    );
    expect((ok.q as string).length).toBe(5000);
  });
});

describe("response headers (0.7)", () => {
  test("every envelope is uncacheable, unframeable by other sites and nosniff", () => {
    const res = envelope(403, "E_FORBIDDEN", "no");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-security-policy")).toBe("frame-ancestors 'self'");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Object.keys(API_HEADERS).length).toBe(3);
  });

  test("a 403 names the missing grant", async () => {
    const res = envelope(403, "E_FORBIDDEN", "no", {}, { missing: "edit", source: "yon-bip" });
    expect(await res.json()).toEqual({
      error: "no",
      code: "E_FORBIDDEN",
      missing: "edit",
      source: "yon-bip",
    });
  });
});
