import { describe, expect, test } from "bun:test";
import { CliExecutionError, CliValidationError } from "../drivers/cli";
import { McpError } from "../drivers/mcp";
import { BadRequestError } from "../http";
import { mapError } from "./api";

// source-passthrough tests at the bottom import the handlers themselves

// mapError is the single error surface every /api route funnels through
// (index.ts catch-all). The contract that matters: validation failures are
// 400s, upstream (MCP/CLI) failures are 502/504 with the bounded upstream
// message, and only truly unexpected errors degrade to an opaque 500.

describe("mapError", () => {
  test("validation errors are 400 E_BAD_REQUEST", async () => {
    for (const err of [new BadRequestError("bad id"), new CliValidationError("takes propose accept: invalid id \"x\"")]) {
      const res = mapError(err);
      expect(res.status).toBe(400);
      const body = (await res.json()) as { code: string; error: string };
      expect(body.code).toBe("E_BAD_REQUEST");
      expect(body.error).toBe(err.message);
    }
  });

  test("CLI execution failure is 502 E_UPSTREAM carrying the stderr first line", async () => {
    const err = new CliExecutionError(
      "takes propose accept failed: No brain directory configured. Pass --dir <path> or run `gbrain init` first.",
      1,
    );
    const res = mapError(err);
    expect(res.status).toBe(502);
    const body = (await res.json()) as { code: string; error: string };
    expect(body.code).toBe("E_UPSTREAM");
    expect(body.error).toContain("No brain directory configured");
  });

  test("CLI timeout is 504 E_UPSTREAM", async () => {
    const res = mapError(new CliExecutionError("takes propose accept: timed out", undefined, true));
    expect(res.status).toBe(504);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("E_UPSTREAM");
  });

  test("MCP auth error stays 502 E_UPSTREAM_AUTH", async () => {
    const res = mapError(new McpError("auth", "token rejected"));
    expect(res.status).toBe(502);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("E_UPSTREAM_AUTH");
  });

  test("unknown errors degrade to 500 E_INTERNAL without leaking the message", async () => {
    const res = mapError(new Error("postgres went sideways: secret-dsn"));
    expect(res.status).toBe(500);
    const body = (await res.json()) as { code: string; error: string };
    expect(body.code).toBe("E_INTERNAL");
    expect(body.error).not.toContain("secret-dsn");
  });
});

// --- source passthrough (P1 source axis) -------------------------------------

import { handlePage, handlePages, handleSearch, handleSources } from "./api";
import type { ApiContext } from "./api";
import type { McpDriver } from "../drivers/mcp";
import type { SourceSummary, SourcesReport } from "@gbrain-cockpit/shared";

function stubCtx(calls: {
  pages?: unknown;
  page?: unknown;
  hits?: unknown;
  sources?: unknown;
  sourcesErr?: Error;
}) {
  const seen: Record<string, unknown[]> = {};
  const mcp = {
    listPages: async (p: unknown) => {
      (seen.listPages ??= []).push(p);
      return calls.pages ?? [];
    },
    getPage: async (slug: unknown, sourceId: unknown) => {
      (seen.getPage ??= []).push([slug, sourceId]);
      return calls.page ?? {};
    },
    versions: async () => [],
    search: async (q: unknown, sourceId: unknown) => {
      (seen.search ??= []).push([q, sourceId]);
      return calls.hits ?? [];
    },
    sourcesList: async () => {
      if (calls.sourcesErr) throw calls.sourcesErr;
      return calls.sources ?? [];
    },
  } as unknown as McpDriver;
  return {
    ctx: { mcp, cli: null, pg: null, id: "t", profile: {}, cliBinResolved: null } as unknown as ApiContext,
    seen,
  };
}

describe("source passthrough", () => {
  test("/api/page forwards source_id to getPage; disambiguation is explicit", async () => {
    const { ctx, seen } = stubCtx({ page: { slug: "a", source_id: "main" } });
    const res = await handlePage(
      ctx,
      new URL("http://x/api/page?slug=a&source_id=main"),
    );
    expect(res.status).toBe(200);
    expect(seen["getPage"]![0]).toEqual(["a", "main"]);
    // no source_id → undefined, never a guess
    await handlePage(ctx, new URL("http://x/api/page?slug=a"));
    expect(seen["getPage"]![1]).toEqual(["a", undefined]);
  });

  test("invalid and reserved source_ids are 400s before any driver call", async () => {
    const { ctx, seen } = stubCtx({});
    for (const bad of ["__all__", "a/b", "has space", ""]) {
      const url = new URL(`http://x/api/page?slug=a&source_id=${encodeURIComponent(bad)}`);
      if (bad === "") continue; // empty param reads as absent (param())
      const res = await handlePage(ctx, url).catch((e) => e);
      expect(res).toBeInstanceOf(BadRequestError);
    }
    expect(seen["getPage"]).toBeUndefined();
  });

  test("/api/pages and /api/search forward source_id (server-side narrowing)", async () => {
    const { ctx, seen } = stubCtx({});
    await handlePages(ctx, new URL("http://x/api/pages?source_id=archive"));
    await handleSearch(ctx, new URL("http://x/api/search?q=re&source_id=archive"));
    expect((seen.listPages![0] as { sourceId?: string }).sourceId).toBe("archive");
    expect(seen.search![0]).toEqual(["re", "archive"]);
  });

  test("/api/sources: ok carries items; failure degrades in-band, never an envelope", async () => {
    const ok = stubCtx({ sources: [{ id: "main", page_count: 100 }] });
    const res = await handleSources(ok.ctx);
    const body = (await res.json()) as SourcesReport;
    expect(body.status).toBe("ok");
    expect((body.items as SourceSummary[])[0]!.id).toBe("main");

    const down = stubCtx({ sourcesErr: new Error("mcp dead") });
    const res2 = await handleSources(down.ctx);
    const body2 = (await res2.json()) as SourcesReport;
    expect(res2.status).toBe(200);
    expect(body2.status).toBe("down");
  });
});
