import { describe, expect, test } from "bun:test";
import { guardRequest, readJsonBody, BadRequestError } from "./http";
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
