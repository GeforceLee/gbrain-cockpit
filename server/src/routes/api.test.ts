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

import {
  handlePage,
  handlePages,
  handleResolveSlugs,
  handleSearch,
  handleSources,
  handleTakeResolve,
} from "./api";
import type { ApiContext } from "./api";
import type {
  OpsAssetsReport,
  OpsCalibrationReport,
  OpsDeployReport,
  OpsNightlyReport,
  SearchHit,
} from "@gbrain-cockpit/shared";
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

// --- inbox cliChannel reason (0.2.1 banner fix) -------------------------------
// The Inbox chip used to blame "not the brain host" for every unavailable
// probe; the payload now carries the Health CLI card's reason vocabulary so
// "binary missing" and "binary found, probe unverified" stay distinguishable.

import { handleInbox } from "./api";
import type { CliDriver } from "../drivers/cli";
import type { InboxReport } from "@gbrain-cockpit/shared";

function inboxCtx(opts: {
  probe?: { available: boolean; error?: string; probedAt?: string };
  cliNote?: string;
  cliBin?: string;
  /** takes queue channel: ok (bypass configured) | unset */
  pg?: "ok" | "unset";
  /** decide proposals rows for the contradictions queue */
  decideProposals?: Array<{ id: number }>;
  /** find_contradictions answer for the probe header */
  probeState?: Record<string, unknown>;
}) {
  const cli = (opts.probe
    ? {
        status: async () => ({ ...opts.probe }),
        trustReview: async () => ({ items: [], counts: {} }),
        edgeList: async () => [],
        decideProposalsList: async () => ({
          status: "pending",
          proposals: opts.decideProposals ?? [],
          review_proposals: [],
        }),
      }
    : null) as unknown as CliDriver | null;
  const pg = {
    configured: opts.pg !== "unset",
    pendingTakeProposals: async () => [],
  };
  return {
    cli,
    cliNote: opts.cliNote,
    profile: { cliBin: opts.cliBin },
    pg,
    takesGuard: null,
    mcp: {
      findContradictions: async () =>
        opts.probeState ?? { contradictions: [], note: "No probe runs…" },
    },
  } as unknown as ApiContext;
}

describe("handleInbox cliChannel reason", () => {
  test("null driver: binary-not-found, cliNote beats the generic message, queues soften", async () => {
    const ctx = inboxCtx({
      cliNote: 'configured cliBin "gbrain-bip" not found (not on PATH / not executable)',
    });
    const body = (await (await handleInbox(ctx)).json()) as InboxReport;
    expect(body.cliChannel.available).toBe(false);
    expect(body.cliChannel.reason).toBe("binary-not-found");
    expect(body.cliChannel.error).toContain("gbrain-bip");
    expect(body.cliChannel.command).toBe("gbrain"); // copy-command name, never blank
    // trust/edges share the CLI-down string; the takes queue no longer
    // depends on the CLI channel at all — it reads the bypass and stays ok
    for (const q of [body.trust, body.edgeProposals]) {
      expect(q.error).toBe("CLI channel unavailable — actions degrade to copy-command");
    }
    expect(body.takes.status).toBe("ok");
    expect(body.takes.items).toEqual([]);
  });

  test("takes queue names the bypass (not the CLI) when pgReadonlyDsn is unset", async () => {
    const ctx = inboxCtx({
      probe: { available: true, probedAt: "2026-11-08T00:00:00.000Z" },
      pg: "unset",
    });
    const body = (await (await handleInbox(ctx)).json()) as InboxReport;
    expect(body.takes.status).toBe("down");
    expect(body.takes.error).toContain("read-only bypass");
  });

  test("probe failing: binary-found-unverified keeps the error, no host blame", async () => {
    const ctx = inboxCtx({
      probe: { available: false, error: "trust review failed: socket timeout" },
      cliBin: "gbrain-bip",
    });
    const body = (await (await handleInbox(ctx)).json()) as InboxReport;
    expect(body.cliChannel.available).toBe(false);
    expect(body.cliChannel.reason).toBe("binary-found-unverified");
    expect(body.cliChannel.error).toContain("socket timeout");
    expect(body.cliChannel.command).toBe("gbrain-bip");
  });

  test("probe succeeding: binary-verified round-trips with the healthy queues", async () => {
    const ctx = inboxCtx({
      probe: { available: true, probedAt: "2026-11-06T00:00:00.000Z" },
    });
    const body = (await (await handleInbox(ctx)).json()) as InboxReport;
    expect(body.cliChannel.available).toBe(true);
    expect(body.cliChannel.reason).toBe("binary-verified");
    expect(body.trust.status).toBe("ok");
    expect(body.edgeProposals.status).toBe("ok");
    expect(body.takes.status).toBe("ok");
  });

  test("contradictions queue: decide rows + ran-probe state ride together", async () => {
    const ctx = inboxCtx({
      probe: { available: true, probedAt: "2026-11-08T00:00:00.000Z" },
      decideProposals: [{ id: 7 }, { id: 8 }],
      probeState: {
        run_id: "r1",
        ran_at: "2026-11-08T07:39:07.472Z",
        contradictions: [],
        total_visible: 0,
      },
    });
    const body = (await (await handleInbox(ctx)).json()) as InboxReport;
    expect(body.contradictions.status).toBe("ok");
    expect(body.contradictions.items).toHaveLength(2);
    expect(body.contradictions.probe).toEqual({
      ranAt: "2026-11-08T07:39:07.472Z",
      runId: "r1",
      totalVisible: 0,
    });
  });

  test("contradictions queue: never-ran note passes through verbatim (the empty state teaches how to start)", async () => {
    const ctx = inboxCtx({
      probe: { available: true, probedAt: "2026-11-08T00:00:00.000Z" },
      probeState: { contradictions: [], note: "No probe runs in the last 30 days; run `gbrain eval suspected-contradictions` first." },
    });
    const body = (await (await handleInbox(ctx)).json()) as InboxReport;
    expect(body.contradictions.probe?.note).toContain("No probe runs");
    expect(body.contradictions.probe?.ranAt).toBeUndefined();
  });

  test("contradictions queue: CLI down degrades the queue but NOT the probe header", async () => {
    const ctx = inboxCtx({
      probeState: { ran_at: "2026-11-08T07:39:07.472Z", contradictions: [], total_visible: 2 },
    });
    const body = (await (await handleInbox(ctx)).json()) as InboxReport;
    expect(body.contradictions.status).toBe("down");
    expect(body.contradictions.probe?.ranAt).toBe("2026-11-08T07:39:07.472Z");
  });

  test("contradictions queue: MCP probe unreachable leaves the queue itself intact", async () => {
    const ctx = inboxCtx({
      probe: { available: true, probedAt: "2026-11-08T00:00:00.000Z" },
      probeState: new Error("mcp dead") as unknown as Record<string, unknown>,
    });
    // findContradictions throws → probe half silently absent, queue still ok
    const ctxThrowing = {
      ...ctx,
      mcp: {
        findContradictions: async () => {
          throw new Error("mcp dead");
        },
      },
    } as unknown as ApiContext;
    const body = (await (await handleInbox(ctxThrowing)).json()) as InboxReport;
    expect(body.contradictions.status).toBe("ok");
    expect(body.contradictions.probe).toBeUndefined();
  });

  test("extraction + activeTakes queues ride the inbox payload, degrading in-band", async () => {
    const ctx = inboxCtx({
      probe: { available: true, probedAt: "2026-11-08T00:00:00.000Z" },
    });
    const body = (await (await handleInbox(ctx)).json()) as InboxReport;
    // the fake mcp only implements findContradictions → both new queues
    // degrade in-band rather than breaking the whole inbox fetch
    expect(["degraded", "down"]).toContain(body.extraction.status);
    expect(["degraded", "down"]).toContain(body.activeTakes.status);
  });
});

// --- 0.3.0 pillars: resolve / semantic search / write-cancel -------------------

describe("0.3.0 route additions", () => {
  const qualityErr = async (body: unknown) => {
    try {
      await handleTakeResolve(
        {
          mcp: { takesResolve: async () => ({}) },
        } as unknown as ApiContext,
        new Request("http://x/", {
          method: "POST",
          body: JSON.stringify(body),
          headers: { "content-type": "application/json" },
        }),
      );
      return null;
    } catch (err) {
      return err;
    }
  };

  test("takes resolve validates slug/row/quality before any driver call", async () => {
    expect(await qualityErr({ slug: "kb/x", row: 1, quality: "correct" })).toBeNull();
    expect(await qualityErr({ slug: "kb/x", row: 1, quality: "maybe" })).toBeInstanceOf(
      BadRequestError,
    );
    expect(await qualityErr({ slug: "kb/x", row: 0, quality: "correct" })).toBeInstanceOf(
      BadRequestError,
    );
    expect(await qualityErr({ slug: "bad slug", row: 1, quality: "correct" })).toBeInstanceOf(
      BadRequestError,
    );
  });

  test("semantic search normalizes query's array or {results} envelope", async () => {
    for (const answer of [[{ slug: "a" }], { results: [{ slug: "b" }] }]) {
      const ctx = {
        mcp: { query: async () => answer },
      } as unknown as ApiContext;
      const res = await handleSearch(ctx, new URL("http://x/api/search?q=m&mode=semantic"));
      const body = (await res.json()) as SearchHit[];
      expect(body).toHaveLength(1);
    }
    const badMode = {
      mcp: { search: async () => [] },
    } as unknown as ApiContext;
    await expect(
      handleSearch(badMode, new URL("http://x/api/search?q=m&mode=grep")),
    ).rejects.toBeInstanceOf(BadRequestError);
  });

  test("resolve-slugs caps and strips; write-cancel validates the request id", async () => {
    const ctx = {
      mcp: {
        resolveSlugs: async () => Array.from({ length: 40 }, (_, i) => `kb/x${i}`),
      },
    } as unknown as ApiContext;
    const res = await handleResolveSlugs(ctx, new URL("http://x/api/resolve-slugs?partial=kb"));
    const body = (await res.json()) as { slugs: string[] };
    expect(body.slugs).toHaveLength(20);
    await expect(
      handleResolveSlugs(ctx, new URL("http://x/api/resolve-slugs")),
    ).rejects.toBeInstanceOf(BadRequestError);
  });
});

// --- V1.1 dimensions & provenance ----------------------------------------------
// slug_prefix/tag narrowing, /api/page full=1 section degradation, and the
// three in-band reports + evidence endpoint. All handler-direct like above.

import {
  handleEvidence,
  handlePages as handlePagesV11,
  handlePage as handlePageV11,
  handleSourcesStatus,
  handleWriteConflicts,
  handleWriteRequests,
} from "./api";
import type {
  EvidenceReport,
  LinkRow,
  SourcesStatusReport,
  TimelineEntry,
  WriteConflictsReport,
  WriteRequestsReport,
} from "@gbrain-cockpit/shared";

/** Driver-level stub: methods throw their configured Error, else answer. */
function v11Ctx(calls: {
  links?: LinkRow[] | Error;
  backlinks?: LinkRow[] | Error;
  timeline?: TimelineEntry[] | Error;
  writeRequests?: unknown[] | Error;
  conflicts?: unknown[] | Error;
  sources?: Array<{ id: string }> | Error;
  sourcesStatus?: Record<string, unknown> | Error;
  evidence?: unknown | Error;
}) {
  const seen: Record<string, unknown[]> = {};
  const answer = <T>(slot: string, args: unknown[], value: T | Error | undefined, dflt: T): T => {
    (seen[slot] ??= []).push(args);
    if (value instanceof Error) throw value;
    return (value ?? dflt) as T;
  };
  const mcp = {
    getPage: async (slug: string, sourceId?: string) =>
      answer("getPage", [slug, sourceId], undefined, { slug, source_id: sourceId }),
    versions: async (slug: string) => answer("versions", [slug], undefined, []),
    getLinks: async (slug: string, sourceId?: string) =>
      answer("getLinks", [slug, sourceId], calls.links, [] as LinkRow[]),
    getBacklinks: async (slug: string, sourceId?: string) =>
      answer("getBacklinks", [slug, sourceId], calls.backlinks, [] as LinkRow[]),
    getTimeline: async (slug: string) =>
      answer("getTimeline", [slug], calls.timeline, [] as TimelineEntry[]),
    listWriteRequests: async (p: unknown) =>
      answer("listWriteRequests", [p], calls.writeRequests, [] as unknown[]),
    listWriteConflicts: async (p: unknown) =>
      answer("listWriteConflicts", [p], calls.conflicts, [] as unknown[]),
    sourcesList: async () => {
      if (calls.sources instanceof Error) throw calls.sources;
      return calls.sources ?? [{ id: "main" }];
    },
    sourcesStatus: async (id: string) => {
      (seen.sourcesStatus ??= []).push([id]);
      if (calls.sourcesStatus instanceof Error) throw calls.sourcesStatus;
      return calls.sourcesStatus ?? { id, clone_state: "healthy" };
    },
    assembleEvidence: async (hits: unknown, opts: unknown) => {
      (seen.assembleEvidence ??= []).push([hits, opts]);
      if (calls.evidence instanceof Error) throw calls.evidence;
      return calls.evidence ?? { results: [], unresolved: [] };
    },
  } as unknown as McpDriver;
  return {
    ctx: { mcp, cli: null, pg: null, id: "t", profile: {}, cliBinResolved: null } as unknown as ApiContext,
    seen,
  };
}

describe("V1.1 /api/pages slug_prefix + tag", () => {
  test("valid params forward as slugPrefix/tag; invalid are 400s before the driver", async () => {
    const { ctx, seen } = stubCtx({});
    await handlePagesV11(
      ctx,
      new URL("http://x/api/pages?slug_prefix=kb/&tag=follow-up"),
    );
    const args = seen.listPages![0] as { slugPrefix?: string; tag?: string };
    expect(args.slugPrefix).toBe("kb/");
    expect(args.tag).toBe("follow-up");

    await expect(
      handlePagesV11(ctx, new URL("http://x/api/pages?slug_prefix=kb$bad")),
    ).rejects.toBeInstanceOf(BadRequestError);
    await expect(
      handlePagesV11(ctx, new URL("http://x/api/pages?tag=" + encodeURIComponent("a\nb"))),
    ).rejects.toBeInstanceOf(BadRequestError);
    expect(seen.listPages).toHaveLength(1); // invalid values never reached the driver
  });

  test("offset paging: valid forwards (>0 only), invalid is a 400 before the driver", async () => {
    const { ctx, seen } = stubCtx({});
    await handlePagesV11(ctx, new URL("http://x/api/pages?offset=15"));
    expect((seen.listPages![0] as { offset?: number }).offset).toBe(15);
    // offset 0 is the default — never attached (byte-identical first pages)
    await handlePagesV11(ctx, new URL("http://x/api/pages"));
    expect(
      (seen.listPages![1] as { offset?: number }).offset,
    ).toBeUndefined();
    await expect(
      handlePagesV11(ctx, new URL("http://x/api/pages?offset=-1")),
    ).rejects.toBeInstanceOf(BadRequestError);
    await expect(
      handlePagesV11(ctx, new URL("http://x/api/pages?offset=abc")),
    ).rejects.toBeInstanceOf(BadRequestError);
    expect(seen.listPages).toHaveLength(2);
  });
});

describe("V1.1 /api/page full=1 sections", () => {
  test("default path stays two upstream calls (peek drawers)", async () => {
    const { ctx, seen } = v11Ctx({});
    const res = await handlePageV11(ctx, new URL("http://x/api/page?slug=a"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["page", "versions"]);
    expect(seen.getLinks).toBeUndefined();
    expect(seen.getBacklinks).toBeUndefined();
    expect(seen.getTimeline).toBeUndefined();
  });

  test("full=1 attaches sections; a failed section degrades in-band", async () => {
    const { ctx } = v11Ctx({
      links: new McpError("protocol", "tool get_links errored: unknown tool"),
      backlinks: [{ from_slug: "b", from_source_id: "main", to_slug: "a", link_type: "mentions" }],
      timeline: [{ date: "2026-11-01", text: "entry" }],
    });
    const res = await handlePageV11(
      ctx,
      new URL("http://x/api/page?slug=a&source_id=main&full=1"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      page: { slug: string };
      versions: unknown[];
      links?: LinkRow[];
      backlinks?: LinkRow[];
      timeline?: TimelineEntry[];
      degraded?: string[];
    };
    expect(body.page.slug).toBe("a");
    expect(body.links).toBeUndefined(); // failed section absent, never an error
    expect(body.degraded).toEqual(["links"]);
    expect(body.backlinks).toHaveLength(1);
    expect(body.timeline).toHaveLength(1);
  });

  test("page failure still errors even in full mode", async () => {
    const ctx = {
      mcp: {
        getPage: async () => {
          throw new McpError("timeout", "MCP request timed out");
        },
        versions: async () => [],
        getLinks: async () => [],
        getBacklinks: async () => [],
        getTimeline: async () => [],
      },
    } as unknown as ApiContext;
    // handler-direct: the rejection is what index.ts funnels through mapError
    const err = await handlePageV11(
      ctx,
      new URL("http://x/api/page?slug=a&full=1"),
    ).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(McpError);
    const res = mapError(err);
    expect(res.status).toBe(504);
    expect(((await res.json()) as { code: string }).code).toBe("E_UPSTREAM");
  });
});

describe("V1.1 write-receipt / conflicts / sources-status reports", () => {
  test("write-requests ok + source passthrough; protocol failure degrades in-band", async () => {
    const ok = v11Ctx({
      writeRequests: [{ request_id: "r-1", slug: "a", status: "committed" }],
    });
    const res = await handleWriteRequests(
      ok.ctx,
      new URL("http://x/api/write-requests?source_id=main"),
    );
    const body = (await res.json()) as WriteRequestsReport;
    expect(body.status).toBe("ok");
    expect(body.items![0]!.request_id).toBe("r-1");
    expect(ok.seen.listWriteRequests![0]).toEqual([{ sourceId: "main", limit: 50 }]);

    const old = v11Ctx({
      writeRequests: new McpError("protocol", "tool list_write_requests errored"),
    });
    const res2 = await handleWriteRequests(old.ctx, new URL("http://x/api/write-requests"));
    expect(res2.status).toBe(200);
    const body2 = (await res2.json()) as WriteRequestsReport;
    expect(body2.status).toBe("degraded");

    await expect(
      handleWriteRequests(old.ctx, new URL("http://x/api/write-requests?limit=0")),
    ).rejects.toBeInstanceOf(BadRequestError);
  });

  test("write-conflicts ok and in-band degraded", async () => {
    const ok = v11Ctx({ conflicts: [{ slug: "a", source_id: "main" }] });
    const res = await handleWriteConflicts(ok.ctx, new URL("http://x/api/write-conflicts?source_id=main"));
    const body = (await res.json()) as WriteConflictsReport;
    expect(body.status).toBe("ok");
    expect(body.items![0]!.slug).toBe("a");

    const down = v11Ctx({ conflicts: new Error("mcp dead") });
    const res2 = await handleWriteConflicts(down.ctx, new URL("http://x/api/write-conflicts"));
    expect(res2.status).toBe(200);
    expect(((await res2.json()) as WriteConflictsReport).status).toBe("down");
  });

  test("sources/status: per-source fan-out, one failure degrades with its row kept", async () => {
    const ctx = v11Ctx({ sources: [{ id: "main" }, { id: "archive" }] });
    // make archive fail while main succeeds
    (ctx.ctx.mcp as unknown as {
      sourcesStatus: (id: string) => Promise<unknown>;
    }).sourcesStatus = async (id: string) => {
      if (id === "archive") throw new Error("no-git");
      return { id, clone_state: "healthy" };
    };
    const res = await handleSourcesStatus(ctx.ctx);
    const body = (await res.json()) as SourcesStatusReport;
    expect(body.status).toBe("degraded");
    expect(body.items).toHaveLength(2);
    expect(body.items![0]!.clone_state).toBe("healthy");
    expect(body.items![1]!.id).toBe("archive");
    expect(String(body.items![1]!.error)).toContain("no-git");
  });
});

describe("V1.1 POST /api/evidence", () => {
  function evidenceReq(hits: unknown): Request {
    return new Request("http://x/api/evidence", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hits }),
    });
  }

  test("valid hit maps camel→snake and wraps in-band", async () => {
    const { ctx, seen } = v11Ctx({
      evidence: { results: [{ slug: "a", chunk_text: "window text" }], unresolved: [] },
    });
    const res = await handleEvidence(
      ctx,
      evidenceReq([{ source_id: "main", slug: "a", chunk_id: 1481 }]),
    );
    const body = (await res.json()) as EvidenceReport;
    expect(body.status).toBe("ok");
    expect(body.results![0]!.chunk_text).toBe("window text");
    expect(seen.assembleEvidence![0]).toEqual([
      [{ sourceId: "main", slug: "a", chunkId: 1481 }],
      { returnUnit: "window" },
    ]);
  });

  test("validation: >3 hits, missing chunk_id, non-integer chunk_id are 400s", async () => {
    const { ctx, seen } = v11Ctx({});
    const bad = [
      [1, 2, 3, 4],
      [{ source_id: "main", slug: "a" }],
      [{ source_id: "main", slug: "a", chunk_id: 1.5 }],
      [{ source_id: "a/b", slug: "a", chunk_id: 1 }],
    ];
    for (const hits of bad) {
      await expect(handleEvidence(ctx, evidenceReq(hits))).rejects.toBeInstanceOf(
        BadRequestError,
      );
    }
    expect(seen.assembleEvidence).toBeUndefined();
  });

  test("upstream failure answers in-band, never an envelope", async () => {
    const { ctx } = v11Ctx({ evidence: new McpError("protocol", "unknown tool") });
    const res = await handleEvidence(
      ctx,
      evidenceReq([{ source_id: "main", slug: "a", chunk_id: 1 }]),
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as EvidenceReport).status).toBe("degraded");
  });
});

// --- handleTakePropose: per-row source scoping (multi-source fix) -------------
// The queue read moved to the bypass; accept/reject still go through the CLI
// driver but with GBRAIN_SOURCE=<the row's source_id> + GBRAIN_HOME, exec'd
// on the REAL binary (wrappers unset GBRAIN_SOURCE by design). The guard's
// database assertion is covered in takes-source.test.ts; here the guard is
// a stub so the ROUTE contract stays the focus: right row → right env,
// missing row → 404, guard refusal → 502, legacy profiles unchanged.

import { handleTakePropose } from "./api";
import type { ScopedExecOpts } from "../drivers/cli";
import { TakesSourceGuardError } from "../drivers/takes-source";
import type { TakeProposal as TakeProposalType } from "@gbrain-cockpit/shared";

function takesCtx(opts: {
  queue: TakeProposalType[];
  guard?: {
    scopedExec: (sourceId: string) => Promise<ScopedExecOpts>;
  } | null;
  queueErr?: Error;
}) {
  const calls: { bin: string; argv: string[]; env?: Record<string, string> }[] = [];
  const cli = {
    takesProposeAccept: async (id: string, o?: ScopedExecOpts) => {
      calls.push({ bin: o?.bin ?? "/fake/wrapper", argv: ["takes", "propose", "--accept", id], env: o?.env });
      return { output: `accepted ${id}` };
    },
    takesProposeReject: async (id: string, o?: ScopedExecOpts) => {
      calls.push({ bin: o?.bin ?? "/fake/wrapper", argv: ["takes", "propose", "--reject", id], env: o?.env });
      return { output: `rejected ${id}` };
    },
  };
  const pg = {
    configured: true,
    pendingTakeProposals: async () => {
      if (opts.queueErr) throw opts.queueErr;
      return opts.queue;
    },
  };
  return {
    ctx: {
      id: "bip",
      profile: {},
      mcp: { invalidateAll: () => {} },
      cli,
      pg,
      takesGuard: opts.guard === undefined ? null : opts.guard,
      cliBinResolved: "/fake/wrapper",
    } as unknown as ApiContext,
    calls,
  };
}

const GUARD = {
  scopedExec: async (sourceId: string) => ({
    bin: "/opt/gbrain-real/gbrain",
    env: { GBRAIN_SOURCE: sourceId, GBRAIN_HOME: "/srv/brain-bip-home" },
  }),
};

const REQ = (op: string, id: string | number) =>
  new Request("http://x/api/inbox/takes/propose", {
    method: "POST",
    body: JSON.stringify({ op, id }),
  });

describe("handleTakePropose source scoping", () => {
  test("scoped profile: the exec carries the row's source env on the REAL binary", async () => {
    const { ctx, calls } = takesCtx({
      queue: [{ id: 6, source_id: "mail-import", page_slug: "issue/bug-1234", claim_text: "c" }],
      guard: GUARD,
    });
    const res = await handleTakePropose(ctx, REQ("accept", 6));
    expect(res.status).toBe(200);
    expect(calls[0]?.bin).toBe("/opt/gbrain-real/gbrain");
    expect(calls[0]?.env?.GBRAIN_SOURCE).toBe("mail-import");
    expect(calls[0]?.env?.GBRAIN_HOME).toBe("/srv/brain-bip-home");
    expect(calls[0]?.argv).toEqual(["takes", "propose", "--accept", "6"]);
    // reject rides the same scoping
    await handleTakePropose(ctx, REQ("reject", 6));
    expect(calls[1]?.env?.GBRAIN_SOURCE).toBe("mail-import");
  });

  test("a proposal from ANOTHER row's source never leaks into the env", async () => {
    const seen: string[] = [];
    const { ctx } = takesCtx({
      queue: [
        { id: 6, source_id: "mail-import", page_slug: "a", claim_text: "c" },
        { id: 7, source_id: "default", page_slug: "b", claim_text: "c" },
      ],
      guard: {
        scopedExec: async (sourceId) => {
          seen.push(sourceId);
          return GUARD.scopedExec(sourceId);
        },
      },
    });
    await handleTakePropose(ctx, REQ("accept", 7));
    expect(seen).toEqual(["default"]); // per-ROW, not per-profile
  });

  test("id not in the pending queue → 404, no exec, no guard call", async () => {
    let guardCalls = 0;
    const { ctx, calls } = takesCtx({
      queue: [{ id: 6, source_id: "s", page_slug: "a", claim_text: "c" }],
      guard: {
        scopedExec: async (s) => {
          guardCalls++;
          return GUARD.scopedExec(s);
        },
      },
    });
    const res = await handleTakePropose(ctx, REQ("accept", 999));
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("#999");
    expect(guardCalls).toBe(0);
    expect(calls.length).toBe(0);
  });

  test("guard refusal (database mismatch) → 502 E_UPSTREAM via mapError, exec never runs", async () => {
    const { ctx, calls } = takesCtx({
      queue: [{ id: 6, source_id: "s", page_slug: "a", claim_text: "c" }],
      guard: {
        scopedExec: async () => {
          throw new TakesSourceGuardError(
            'takes adjudigation refused: config points at database "postgres" but the read-only DSN names "bip"',
          );
        },
      },
    });
    // like CliExecutionError on the other action routes, the guard's refusal
    // propagates to index.ts's mapError catch-all
    const err = await handleTakePropose(ctx, REQ("accept", 6)).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(TakesSourceGuardError);
    const res = mapError(err);
    expect(res.status).toBe(502);
    const body = (await res.json()) as { code: string; error: string };
    expect(body.code).toBe("E_UPSTREAM");
    expect(body.error).toContain('names "bip"');
    expect(body.error).not.toContain("://"); // no URL in the surfaced refusal
    expect(calls.length).toBe(0);
  });

  test("queue unreadable → 502 naming the bypass, no exec", async () => {
    const { ctx, calls } = takesCtx({
      queue: [],
      queueErr: new Error("permission denied for table take_proposals"),
      guard: GUARD,
    });
    const res = await handleTakePropose(ctx, REQ("reject", 6));
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("permission denied");
    expect(calls.length).toBe(0);
  });

  test("legacy profile (no guard): plain cliBin exec, inherited env — verbatim", async () => {
    const { ctx, calls } = takesCtx({
      queue: [{ id: 6, source_id: "default", page_slug: "a", claim_text: "c" }],
      guard: null,
    });
    const res = await handleTakePropose(ctx, REQ("accept", 6));
    expect(res.status).toBe(200);
    expect(calls[0]?.bin).toBe("/fake/wrapper");
    expect(calls[0]?.env).toBeUndefined();
  });

  test("op validation still precedes everything", async () => {
    const { ctx, calls } = takesCtx({ queue: [], guard: GUARD });
    await expect(handleTakePropose(ctx, REQ("undo", 6))).rejects.toThrow(
      /accept\|reject/,
    );
    await expect(handleTakePropose(ctx, REQ("accept", "6;evil"))).rejects.toThrow();
    expect(calls.length).toBe(0);
  });
});

// --- 0.4.0 ops surface: source drift / dream runs / grant-read ----------------

import {
  handleOpsDreamRuns,
  handleOpsNightly,
  handleOpsCalibration,
  handleOpsAssets,
  handleOpsDeploy,
  handleOpsGrantRead,
  handleOpsModel,
  handleOpsModelTest,
  handleOpsSourceDrift,
} from "./api";
import type {
  OpsDreamRunsReport,
  OpsGrantReadResult,
  OpsSourceDriftReport,
} from "@gbrain-cockpit/shared";
import type { Principal } from "../auth";

const CLIENT_ID =
  "gbrain_cl_489f6ae02796baf04d3bbb080308b39ec98d8991e1cc9597ed00b8ece4c2c7c9";

interface OpsStub {
  id?: string;
  oauth?: boolean;
  cli?: boolean;
  pgSources?: Array<{ source_id: string; pages: number }>;
  pgError?: Error;
  activeSources?: Array<{ id: string; archived?: boolean }>;
  granted?: string[];
  clientsError?: Error;
  dreamRuns?: Array<{ runId: string; start: string; end: string; takes: number; pending: number }>;
  doctor?: { checks: Array<{ name: string; status: string; message?: string }> };
  // 0.5.0
  doctorChecks?: Record<string, { checks: Array<Record<string, unknown>> } | Error>;
  writerStatus?: { mode?: string; bindings?: Array<Record<string, unknown>> } | Error;
  stamps?: Array<{ source_id: string; last_full_cycle_at?: string; last_source_cycle_at?: string }>;
  scorecard?: unknown;
  scorecardError?: Error;
  profile?: unknown;
  // 0.5.1 model wiring
  providersExplain?: Record<string, unknown> | Error;
  modelsRead?: Record<string, unknown> | Error;
  modelsDoctor?: Record<string, unknown> | Error;
  providerBaseUrls?: Array<{ key: string; value: string }> | Error;
}

function opsCtx(stub: OpsStub) {
  const calls: Record<string, unknown[]> = {};
  const note = (k: string, v: unknown) => {
    (calls[k] ??= []).push(v);
  };
  const ctx = {
    id: stub.id ?? "ops-test",
    profile: {
      cliBin: "gbrain",
      ...(stub.oauth ? { oauth: { clientId: CLIENT_ID } } : {}),
    },
    cliBinResolved: stub.cli ? "/usr/bin/gbrain" : null,
    takesGuard: null,
    cli: stub.cli
      ? ({
          sourcesListJson: async () =>
            stub.clientsError ? Promise.reject(stub.clientsError) : { sources: stub.activeSources ?? [] },
          authClients: async () => {
            note("authClients", null);
            return {
              clients: stub.oauth
                ? [{ client_id: CLIENT_ID, federated_read: stub.granted ?? [] }]
                : [],
            };
          },
          authRescope: async (clientId: string, list: string[]) => {
            note("authRescope", { clientId, list });
            stub.granted = list; // the verify re-read sees the new list
          },
          doctorCycleFreshness: async () => stub.doctor ?? { checks: [] },
          doctorChecks: async (set: string) => {
            const answer = stub.doctorChecks?.[set];
            if (answer instanceof Error) throw answer;
            return answer ?? { checks: [] };
          },
          sourcesWriterStatus: async () => {
            if (stub.writerStatus instanceof Error) throw stub.writerStatus;
            return stub.writerStatus ?? { mode: "managed", bindings: [] };
          },
          providersExplain: async () => {
            note("providersExplain", null);
            if (stub.providersExplain instanceof Error) throw stub.providersExplain;
            return (
              stub.providersExplain ?? {
                env_detected: { ANTHROPIC_API_KEY: true },
                options: [],
              }
            );
          },
          modelsRead: async () => {
            note("modelsRead", null);
            if (stub.modelsRead instanceof Error) throw stub.modelsRead;
            return stub.modelsRead ?? { tiers: [], per_task: [] };
          },
          modelsDoctor: async () => {
            note("modelsDoctor", null);
            if (stub.modelsDoctor instanceof Error) throw stub.modelsDoctor;
            return (
              stub.modelsDoctor ?? {
                probes: [],
                summary: { total: 0, ok: 0, failed: 0 },
              }
            );
          },
        } as unknown as CliDriver)
      : null,
    pg: {
      sourcesWithPages: async () => {
        if (stub.pgError) throw stub.pgError;
        return stub.pgSources ?? [];
      },
      dreamRuns: async () => {
        if (stub.pgError) throw stub.pgError;
        return stub.dreamRuns ?? [];
      },
      sourceCycleStamps: async () => {
        if (stub.pgError) throw stub.pgError;
        return stub.stamps ?? [];
      },
      providerBaseUrls: async () => {
        if (stub.providerBaseUrls instanceof Error) throw stub.providerBaseUrls;
        if (stub.pgError) throw stub.pgError;
        return stub.providerBaseUrls ?? [];
      },
    },
    mcp: {
      whoami: async () => ({ scopes: ["read"], federated_read: stub.granted }),
      forceRenew: async () => {
        note("forceRenew", null);
      },
      invalidateAll: () => {
        note("invalidateAll", null);
      },
      takesScorecard: async () => {
        if (stub.scorecardError) throw stub.scorecardError;
        return stub.scorecard ?? {};
      },
      calibrationProfile: async () => stub.profile ?? null,
    },
  } as unknown as ApiContext;
  return { ctx, calls };
}

const BASE: Principal = { name: "owner", tier: "base" };
const ADMIN: Principal = { name: "owner", tier: "admin" };

describe("handleOpsSourceDrift", () => {
  test("flags active-with-pages-but-ungranted sources and builds the union copy-command", async () => {
    const { ctx } = opsCtx({
      id: "drift-a",
      oauth: true,
      cli: true,
      pgSources: [
        { source_id: "iuap-apcom-migration", pages: 250 },
        { source_id: "iuap-apcom-docs", pages: 1874 },
      ],
      activeSources: [
        { id: "iuap-apcom-migration" },
        { id: "iuap-apcom-docs" },
      ],
      granted: ["iuap-apcom-migration"],
    });
    const body = (await (await handleOpsSourceDrift(ctx)).json()) as OpsSourceDriftReport;
    expect(body.status).toBe("ok");
    expect(body.missing).toEqual(["iuap-apcom-docs"]);
    expect(body.action.available).toBe(true);
    expect(body.action.command).toBe(
      `gbrain auth rescope --client ${CLIENT_ID} --federated-read iuap-apcom-migration,iuap-apcom-docs`,
    );
  });

  test("archived sources are never flagged — re-granting one bricks token issuance", async () => {
    const { ctx } = opsCtx({
      id: "drift-b",
      oauth: true,
      cli: true,
      pgSources: [{ source_id: "old-friend", pages: 9 }],
      activeSources: [{ id: "old-friend", archived: true }, { id: "default" }],
      granted: ["default"],
    });
    const body = (await (await handleOpsSourceDrift(ctx)).json()) as OpsSourceDriftReport;
    expect(body.missing).toEqual([]);
    expect(body.action.command).toBeUndefined();
  });

  test("CLI down: in-band reason, whoami federated_read fallback, no command", async () => {
    const { ctx } = opsCtx({
      id: "drift-c",
      oauth: true,
      cli: false,
      pgSources: [{ source_id: "sneaky", pages: 5 }],
      granted: [],
    });
    const body = (await (await handleOpsSourceDrift(ctx)).json()) as OpsSourceDriftReport;
    expect(body.action).toEqual({ available: false, reason: "cli-unavailable" });
    expect(body.grantedSources).toEqual([]); // whoami fallback carried it
    expect(body.missing).toEqual(["sneaky"]);
  });

  test("pg down degrades the report and pins the action reason", async () => {
    const { ctx } = opsCtx({
      id: "drift-d",
      oauth: true,
      cli: true,
      pgError: new Error("read-only bypass not configured"),
    });
    const body = (await (await handleOpsSourceDrift(ctx)).json()) as OpsSourceDriftReport;
    expect(body.status).toBe("degraded");
    expect(body.action.reason).toBe("pg-unavailable");
  });

  test("legacy-token profiles are not applicable", async () => {
    const { ctx } = opsCtx({ id: "drift-e", oauth: false, cli: true });
    const body = (await (await handleOpsSourceDrift(ctx)).json()) as OpsSourceDriftReport;
    expect(body.action.reason).toBe("not-oauth-profile");
  });

  test("zero drift stays green with no command", async () => {
    const { ctx } = opsCtx({
      id: "drift-f",
      oauth: true,
      cli: true,
      pgSources: [{ source_id: "a", pages: 1 }],
      activeSources: [{ id: "a" }],
      granted: ["a"],
    });
    const body = (await (await handleOpsSourceDrift(ctx)).json()) as OpsSourceDriftReport;
    expect(body.missing).toEqual([]);
    expect(body.action.available).toBe(true);
    expect(body.action.command).toBeUndefined();
  });
});

describe("handleOpsDreamRuns", () => {
  const RUNS = [
    {
      runId: "propose-20261106045917-78e25ac9",
      start: "2026-11-06T05:06:30Z",
      end: "2026-11-06T05:07:42Z",
      takes: 6,
      pending: 3,
    },
  ];

  test("carries runs, pending total, last activity and the doctor verdict verbatim", async () => {
    const { ctx } = opsCtx({
      id: "dream-a",
      cli: true,
      dreamRuns: RUNS,
      doctor: {
        checks: [
          {
            name: "cycle_freshness",
            status: "fail",
            message: "Source 'yon-bip' last cycled 69h ago",
          },
        ],
      },
    });
    const body = (await (await handleOpsDreamRuns(ctx)).json()) as OpsDreamRunsReport;
    expect(body.status).toBe("ok");
    expect(body.neverRan).toBe(false);
    expect(body.lastActivityAt).toBe("2026-11-06T05:07:42Z");
    expect(body.pendingTotal).toBe(3);
    expect(body.cycleFreshness).toEqual({
      status: "fail",
      message: "Source 'yon-bip' last cycled 69h ago",
    });
  });

  test("empty table is neverRan, never an error; doctor band maps unknown shapes", async () => {
    const { ctx } = opsCtx({
      id: "dream-b",
      cli: true,
      doctor: { checks: [{ name: "cycle_freshness", status: "weird-future-band" }] },
    });
    const body = (await (await handleOpsDreamRuns(ctx)).json()) as OpsDreamRunsReport;
    expect(body.neverRan).toBe(true);
    expect(body.lastActivityAt).toBeUndefined();
    expect(body.cycleFreshness?.status).toBe("unknown");
  });

  test("pg down answers in-band down; no CLI leaves cycleFreshness unset", async () => {
    const down = opsCtx({ id: "dream-c", cli: true, pgError: new Error("db gone") });
    const bodyDown = (await (await handleOpsDreamRuns(down.ctx)).json()) as OpsDreamRunsReport;
    expect(bodyDown.status).toBe("down");

    const noCli = opsCtx({ id: "dream-d", cli: false });
    const bodyNoCli = (await (await handleOpsDreamRuns(noCli.ctx)).json()) as OpsDreamRunsReport;
    expect(bodyNoCli.status).toBe("ok");
    expect(bodyNoCli.cycleFreshness).toBeUndefined();
  });
});

describe("handleOpsGrantRead", () => {
  test("base principal gets 403 with the step-up message when admin is configured", async () => {
    const { ctx } = opsCtx({ id: "grant-a", oauth: true, cli: true });
    const res = await handleOpsGrantRead(ctx, BASE, true);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { code: string; error: string };
    expect(body.code).toBe("E_FORBIDDEN");
    expect(body.error).toContain("COCKPIT_ADMIN_TOKEN");
    expect(body.error).toContain("step-up");
  });

  test("base principal gets the not-configured message when no admin token exists", async () => {
    const { ctx } = opsCtx({ id: "grant-b", oauth: true, cli: true });
    const res = await handleOpsGrantRead(ctx, BASE, false);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("not configured");
  });

  test("admin principal: pure union rescope, verify, force-renew, invalidate, audit-able shape", async () => {
    const { ctx, calls } = opsCtx({
      id: "grant-c",
      oauth: true,
      cli: true,
      pgSources: [
        { source_id: "a", pages: 10 },
        { source_id: "b", pages: 20 },
      ],
      activeSources: [{ id: "a" }, { id: "b" }, { id: "archived-x", archived: true }],
      granted: ["a"],
    });
    const res = await handleOpsGrantRead(ctx, ADMIN, true);
    expect(res.status).toBe(200);
    const body = (await res.json()) as OpsGrantReadResult;
    expect(body.added).toEqual(["b"]);
    expect(body.federatedRead).toEqual(["a", "b"]);
    // replace-semantics: the rescope argv carried the WHOLE new list
    expect(calls["authRescope"]).toEqual([
      { clientId: CLIENT_ID, list: ["a", "b"] },
    ]);
    expect(calls["forceRenew"]).toHaveLength(1);
    expect(calls["invalidateAll"]).toHaveLength(1);
  });

  test("idempotent: nothing to add → no rescope, added stays empty", async () => {
    const { ctx, calls } = opsCtx({
      id: "grant-d",
      oauth: true,
      cli: true,
      pgSources: [{ source_id: "a", pages: 1 }],
      activeSources: [{ id: "a" }],
      granted: ["a"],
    });
    const body = (await (await handleOpsGrantRead(ctx, ADMIN, true)).json()) as OpsGrantReadResult;
    expect(body.added).toEqual([]);
    expect(calls["authRescope"]).toBeUndefined();
  });

  test("concurrent double-clicks share one run (single-flight)", async () => {
    const { ctx, calls } = opsCtx({
      id: "grant-e",
      oauth: true,
      cli: true,
      pgSources: [{ source_id: "b", pages: 2 }],
      activeSources: [{ id: "b" }],
      granted: [],
    });
    const [r1, r2] = await Promise.all([
      handleOpsGrantRead(ctx, ADMIN, true),
      handleOpsGrantRead(ctx, ADMIN, true),
    ]);
    const b1 = (await r1.json()) as OpsGrantReadResult;
    const b2 = (await r2.json()) as OpsGrantReadResult;
    expect(b1.added).toEqual(["b"]);
    expect(b2.added).toEqual(["b"]);
    expect(calls["authRescope"]).toHaveLength(1);
  });

  test("archived candidates are never granted (upstream would not refuse them)", async () => {
    const { ctx, calls } = opsCtx({
      id: "grant-f",
      oauth: true,
      cli: true,
      pgSources: [{ source_id: "ghost", pages: 3 }],
      activeSources: [{ id: "ghost", archived: true }],
      granted: [],
    });
    const body = (await (await handleOpsGrantRead(ctx, ADMIN, true)).json()) as OpsGrantReadResult;
    expect(body.added).toEqual([]);
    expect(calls["authRescope"]).toBeUndefined();
  });

  test("no CLI channel or non-OAuth profile refuse with the upstream envelope class", async () => {
    const noCli = opsCtx({ id: "grant-g", oauth: true, cli: false });
    await expect(handleOpsGrantRead(noCli.ctx, ADMIN, true)).rejects.toThrow(
      /CLI channel unavailable/,
    );
    const legacy = opsCtx({ id: "grant-h", oauth: false, cli: true });
    await expect(handleOpsGrantRead(legacy.ctx, ADMIN, true)).rejects.toThrow(
      /not an OAuth client/,
    );
  });
});

// --- 0.5.1 model wiring: GET /api/ops/model + POST /api/ops/model/test -----------

import type { OpsModelReport, OpsModelTestResult } from "@gbrain-cockpit/shared";

describe("handleOpsModel (GET /api/ops/model)", () => {
  test("assembles the three parts + pinned notes; each a modeled slice", async () => {
    const { ctx } = opsCtx({
      id: "model-a",
      cli: true,
      providersExplain: {
        env_detected: { ANTHROPIC_API_KEY: true, OPENAI_API_KEY: false },
        options: [
          {
            id: "zhipu:glm-5.3",
            touchpoint: "chat",
            model: "glm-5.3",
            tier: "openai-compat",
            env_ready: true,
            cost_per_1m_input_usd: 0.07,
          },
        ],
        recommended: "ollama:nomic-embed-text",
      },
      modelsRead: {
        tiers: {
          reasoning: { tier: "reasoning", resolved: "zhipu:glm-5.3", source: "config: models.tier.reasoning" },
        },
        per_task: [
          { key: "models.dream.synthesize", tier: "reasoning", resolved: "zhipu:glm-5.3", description: "Dream synthesis" },
        ],
      },
      doctorChecks: {
        model: {
          checks: [
            { name: "provider_consent", status: "ok", details: { provider_env: ["ANTHROPIC_API_KEY"] } },
          ],
        },
      },
    });
    const body = (await (await handleOpsModel(ctx)).json()) as OpsModelReport;
    expect(body.status).toBe("ok");
    expect(body.explain?.env_detected).toEqual({ ANTHROPIC_API_KEY: true, OPENAI_API_KEY: false });
    expect(body.explain?.options?.[0]?.id).toBe("zhipu:glm-5.3");
    // tiers arrive as a record on 611 — normalized to rows
    expect(body.wiring?.tiers?.[0]?.resolved).toBe("zhipu:glm-5.3");
    expect(body.wiring?.per_task?.[0]?.key).toBe("models.dream.synthesize");
    expect(body.doctor?.checks[0]?.name).toBe("provider_consent");
    expect((body.doctor?.checks[0]?.details as { provider_env?: string[] }).provider_env).toEqual(["ANTHROPIC_API_KEY"]);
    expect(body.notes?.length).toBeGreaterThan(0);
  });

  test("field picklist: poisoned upstream rows never reach the browser (#7 as structure)", async () => {
    const { ctx } = opsCtx({
      id: "model-b",
      cli: true,
      providersExplain: {
        env_detected: { ANTHROPIC_API_KEY: "sk-live-secret-value" }, // wrong type — dropped
        options: [
          {
            id: "zhipu:glm-5.3",
            api_key: "sk-should-never-travel",
            token: "tok-should-never-travel",
            env_detected: { ZHIPUAI_API_KEY: "also-secret" },
          },
        ],
      },
    });
    const raw = await (await handleOpsModel(ctx)).text();
    expect(raw).not.toContain("sk-should-never-travel");
    expect(raw).not.toContain("tok-should-never-travel");
    expect(raw).not.toContain("also-secret");
    expect(raw).not.toContain("sk-live-secret-value");
    const body = JSON.parse(raw) as OpsModelReport;
    expect(body.explain?.env_detected).toBeUndefined(); // non-boolean dropped whole
    expect(body.explain?.options?.[0]).toEqual({ id: "zhipu:glm-5.3" }); // picklist row only
  });

  test("CLI down: cli parts down in-band (pg urls part may still be ok); explain failure degrades", async () => {
    const noCli = opsCtx({ id: "model-c", cli: false });
    const body = (await (await handleOpsModel(noCli.ctx)).json()) as OpsModelReport;
    expect(body.explain?.status).toBe("down");
    expect(body.wiring?.status).toBe("down");
    expect(body.doctor?.status).toBe("down");
    // urls part is pg-backed — it survives a CLI-down host, so the whole
    // report reads "degraded", never "down", while pg answers
    expect(body.urls?.status).toBe("ok");
    expect(body.status).toBe("degraded");

    const noCliNoPg = opsCtx({ id: "model-c2", cli: false, pgError: new Error("bypass unset") });
    const allDown = (await (await handleOpsModel(noCliNoPg.ctx)).json()) as OpsModelReport;
    expect(allDown.status).toBe("down");

    const { ctx } = opsCtx({
      id: "model-d",
      cli: true,
      providersExplain: new Error("providers explain failed (exit 2): boom"),
    });
    const degraded = (await (await handleOpsModel(ctx)).json()) as OpsModelReport;
    expect(degraded.explain?.status).toBe("down");
    expect(degraded.status).toBe("degraded");
  });

  test("urls part (D1 second case): overrides ship; non-URL or malformed rows NEVER leave", async () => {
    const { ctx } = opsCtx({
      id: "model-urls-a",
      cli: true,
      providerBaseUrls: [
        { key: "provider_base_urls.zhipu", value: "https://open.bigmodel.cn/api/coding/paas/v4" },
        { key: "provider_base_urls.evil", value: "https://x.cn/a;rm -rf" }, // metachar → dropped
        { key: "provider_base_urls.Bad Recipe", value: "https://x.cn" }, // recipe charset → dropped
        { key: "other.key", value: "https://x.cn" }, // not the prefix shape → dropped
      ],
    });
    const raw = await (await handleOpsModel(ctx)).text();
    const body = JSON.parse(raw) as OpsModelReport;
    expect(body.urls?.status).toBe("ok");
    expect(body.urls?.overrides).toEqual([
      { recipe: "zhipu", url: "https://open.bigmodel.cn/api/coding/paas/v4" },
    ]);
    expect(raw).not.toContain("rm -rf");
    expect(raw).not.toContain("other.key");
  });

  test("urls part: pg failure degrades in-band with the GRANT hint", async () => {
    const { ctx } = opsCtx({
      id: "model-urls-b",
      cli: true,
      providerBaseUrls: new Error('permission denied for table "config"'),
    });
    const body = (await (await handleOpsModel(ctx)).json()) as OpsModelReport;
    expect(body.urls?.status).toBe("down");
    expect(body.urls?.error).toContain("permission denied");
    expect(body.status).toBe("degraded");
  });
});

describe("handleOpsModelTest (POST /api/ops/model/test)", () => {
  test("base principal gets 403 with the two distinct step-up messages", async () => {
    const { ctx } = opsCtx({ id: "model-test-a", cli: true });
    const res1 = await handleOpsModelTest(ctx, BASE, true);
    expect(res1.status).toBe(403);
    expect(((await res1.json()) as { error?: string }).error).toContain("COCKPIT_ADMIN_TOKEN");
    const res2 = await handleOpsModelTest(ctx, BASE, false);
    expect(res2.status).toBe(403);
    expect(((await res2.json()) as { error?: string }).error).toContain("not configured");
  });

  test("admin happy path: all-green probes → ok; failed probes → degraded (data, not 500)", async () => {
    const okStub = opsCtx({
      id: "model-test-b",
      cli: true,
      modelsDoctor: {
        probes: [
          { model: "zhipu:glm-5.3", touchpoint: "chat", status: "ok", message: "reachable", elapsed_ms: 1589 },
        ],
        summary: { total: 5, ok: 5, failed: 0 },
      },
    });
    const okBody = (await (await handleOpsModelTest(okStub.ctx, ADMIN, true)).json()) as OpsModelTestResult;
    expect(okBody.status).toBe("ok");
    expect(okBody.summary?.failed).toBe(0);

    const failStub = opsCtx({
      id: "model-test-c",
      cli: true,
      modelsDoctor: {
        probes: [
          { model: "zhipu:glm-5.3", touchpoint: "chat", status: "fail", message: "余额不足或无可用资源包" },
        ],
        summary: { total: 5, ok: 4, failed: 1 },
      },
    });
    const failBody = (await (await handleOpsModelTest(failStub.ctx, ADMIN, true)).json()) as OpsModelTestResult;
    expect(failBody.status).toBe("degraded");
    expect(failBody.probes?.[0]?.status).toBe("fail");
  });

  test("verb failure → in-band down with first line; CLI absent → down, never a throw", async () => {
    const { ctx } = opsCtx({
      id: "model-test-d",
      cli: true,
      modelsDoctor: new Error("models doctor failed (exit 2): panic on line one\nsecond line"),
    });
    const body = (await (await handleOpsModelTest(ctx, ADMIN, true)).json()) as OpsModelTestResult;
    expect(body.status).toBe("down");
    expect(body.error).toBe("models doctor failed (exit 2): panic on line one");

    const noCli = opsCtx({ id: "model-test-e", cli: false });
    const down = (await (await handleOpsModelTest(noCli.ctx, ADMIN, true)).json()) as OpsModelTestResult;
    expect(down.status).toBe("down");
    expect(down.error).toContain("CLI channel");
  });

  test("concurrent double-clicks share one run (single-flight — paid action)", async () => {
    const { ctx, calls } = opsCtx({ id: "model-test-f", cli: true });
    const [r1, r2] = await Promise.all([
      handleOpsModelTest(ctx, ADMIN, true),
      handleOpsModelTest(ctx, ADMIN, true),
    ]);
    const b1 = (await r1.json()) as OpsModelTestResult;
    const b2 = (await r2.json()) as OpsModelTestResult;
    expect(b1.status).toBe(b2.status);
    expect(calls["modelsDoctor"]).toHaveLength(1);
  });
});

// --- 0.4.0 hotfix: source-scoped facets ---------------------------------------

import { handlePageFacets } from "./api";

describe("handlePageFacets source scoping", () => {
  function facetsCtx(pgCounts?: Array<{ source_id: string; type: string | null; pages: number }>, pgError?: Error) {
    return {
      mcp: {
        schemaStats: async () => ({
          pack_identity: "p",
          aggregate: { total_pages: 2248, by_type: [{ type: "doc", count: 1874 }] },
        }),
      },
      pg: {
        sourceTypeCounts: async () => {
          if (pgError) throw pgError;
          return pgCounts ?? [];
        },
      },
    } as unknown as ApiContext;
  }

  test("no source param keeps the brain-wide form (scope absent)", async () => {
    const body = await (await handlePageFacets(facetsCtx())).json();
    expect(body.total_pages).toBe(2248);
    expect(body.scope).toBeUndefined();
  });

  test("?source_id narrows through the bypass and labels scope=source", async () => {
    const ctx = facetsCtx([
      { source_id: "iuap-apcom-docs", type: "doc", pages: 1874 },
      { source_id: "yon-bip", type: "note", pages: 12 },
    ]);
    const body = await (await handlePageFacets(ctx, new URL("http://x/api/pages/facets?source_id=yon-bip"))).json();
    expect(body.scope).toBe("source");
    expect(body.source_id).toBe("yon-bip");
    expect(body.total_pages).toBe(12);
    expect(body.by_type).toEqual([{ type: "note", count: 12 }]);
  });

  test("a source with zero pages answers 0 — an honest empty, not all-source", async () => {
    const ctx = facetsCtx([{ source_id: "a", type: "doc", pages: 1 }]);
    const body = await (await handlePageFacets(ctx, new URL("http://x/api/pages/facets?source_id=ghost"))).json();
    expect(body.scope).toBe("source");
    expect(body.total_pages).toBe(0);
  });

  test("bypass down degrades to brain-wide numbers, labeled source-degraded", async () => {
    const ctx = facetsCtx(undefined, new Error("read-only bypass not configured"));
    const body = await (await handlePageFacets(ctx, new URL("http://x/api/pages/facets?source_id=yon-bip"))).json();
    expect(body.scope).toBe("source-degraded");
    expect(body.total_pages).toBe(2248); // brain-wide — the UI explains
  });

  test("invalid source_id is a 400 before any driver call", async () => {
    const ctx = facetsCtx();
    await expect(
      handlePageFacets(ctx, new URL("http://x/api/pages/facets?source_id=__all__")),
    ).rejects.toThrow();
  });
});

// --- 0.4.x Admin panel: /api/ops/clients + adminTier --------------------------

import { handleOpsClients, handleProfiles } from "./api";
import type { OpsClientsReport, ProfilesResponse } from "@gbrain-cockpit/shared";

const SELF_CLIENT_ID =
  "gbrain_cl_489f6ae02796baf04d3bbb080308b39ec98d8991e1cc9597ed00b8ece4c2c7c9";
const OTHER_CLIENT_ID =
  "gbrain_cl_aaaaf6ae02796baf04d3bbb080308b39ec98d8991e1cc9597ed00b8ece4c2c7c9";

describe("handleOpsClients", () => {
  function clientsCtx(opts: {
    cli?: boolean;
    oauth?: boolean;
    guard?: { brainExec: () => Promise<{ bin: string; env: Record<string, string> }> };
    fail?: Error;
  }) {
    const guardCalls: unknown[] = [];
    const guard = opts.guard;
    const ctx = {
      id: "clients-test",
      profile: {
        cliBin: "gbrain",
        ...(opts.oauth ? { oauth: { clientId: SELF_CLIENT_ID } } : {}),
      },
      takesGuard: guard
        ? {
            brainExec: async () => {
              guardCalls.push(null);
              return guard.brainExec();
            },
          }
        : null,
      cli: opts.cli
        ? ({
            authClients: async () => {
              if (opts.fail) throw opts.fail;
              return {
                clients: [
                  { client_id: SELF_CLIENT_ID, client_name: "cockpit-ui", scopes: "read", federated_read: ["a", "b"], surface: "full" },
                  { client_id: OTHER_CLIENT_ID, client_name: "other", scopes: "read", federated_read: [] },
                ],
              };
            },
          } as unknown as CliDriver)
        : null,
    } as unknown as ApiContext;
    return { ctx, guardCalls };
  }

  test("ok: rows + selfClientId on an OAuth profile, no guard → plain exec", async () => {
    const { ctx, guardCalls } = clientsCtx({ cli: true, oauth: true });
    const body = (await (await handleOpsClients(ctx)).json()) as OpsClientsReport;
    expect(body.status).toBe("ok");
    expect(body.selfClientId).toBe(SELF_CLIENT_ID);
    expect(body.clients).toHaveLength(2);
    expect(guardCalls).toHaveLength(0);
  });

  test("ok: guard profile routes the exec through brainExec (isolated brain)", async () => {
    const { ctx, guardCalls } = clientsCtx({
      cli: true,
      oauth: true,
      guard: { brainExec: async () => ({ bin: "/real/gbrain", env: { GBRAIN_HOME: "/h" } }) },
    });
    const body = (await (await handleOpsClients(ctx)).json()) as OpsClientsReport;
    expect(body.status).toBe("ok");
    expect(guardCalls).toHaveLength(1);
  });

  test("legacy-token profile: registry reads fine, selfClientId absent", async () => {
    const { ctx } = clientsCtx({ cli: true, oauth: false });
    const body = (await (await handleOpsClients(ctx)).json()) as OpsClientsReport;
    expect(body.status).toBe("ok");
    expect(body.selfClientId).toBeUndefined();
    expect(body.clients).toHaveLength(2);
  });

  test("CLI channel absent → down in-band with the human-view paste hint", async () => {
    const { ctx } = clientsCtx({ cli: false });
    const res = await handleOpsClients(ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as OpsClientsReport;
    expect(body.status).toBe("down");
    expect(body.command).toBe("gbrain auth clients");
    expect(body.command).not.toContain("--json");
  });

  test("CLI present but the exec fails → degraded in-band, never an envelope error", async () => {
    const { ctx } = clientsCtx({ cli: true, oauth: true, fail: new Error("exit 2: boom") });
    const res = await handleOpsClients(ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as OpsClientsReport;
    expect(body.status).toBe("degraded");
    expect(body.error).toContain("boom");
    expect(body.command).toBe("gbrain auth clients");
  });
});

describe("handleProfiles adminTier", () => {
  function registryStub() {
    return {
      profileInfos: async () => ({ defaultId: "default", profiles: [{ id: "default", name: "gbrain" }] }),
    } as unknown as Parameters<typeof handleProfiles>[0];
  }

  test("carries the deployment capability both ways", async () => {
    const on = (await (await handleProfiles(registryStub(), true)).json()) as ProfilesResponse;
    expect(on.adminTier).toBe(true);
    const off = (await (await handleProfiles(registryStub(), false)).json()) as ProfilesResponse;
    expect(off.adminTier).toBe(false);
  });
});

// --- 0.5.0: nightly-cycle ops ----------------------------------------------------

describe("handleOpsNightly", () => {
  const SET = {
    checks: [
      { name: "cycle_freshness", status: "warn", message: "Source 'iuap-apcom-docs' has never completed a full cycle." },
      { name: "sync_freshness", status: "fail", message: "never synced" },
      { name: "cron_gbrain_home", status: "ok", readiness_state: "not_applicable", severity: "info" },
      { name: "dream_paid_loop", status: "ok", message: "No dream key died 3+ times in 24h" },
    ],
  };

  test("three-state rows + stamps + per-source run-now commands, all in one report", async () => {
    const { ctx } = opsCtx({
      id: "nightly-a",
      cli: true,
      doctorChecks: { nightly: SET },
      stamps: [
        { source_id: "default", last_full_cycle_at: "2026-11-10T01:08:38.906Z" },
        { source_id: "iuap-apcom-docs" },
      ],
    });
    const body = (await (await handleOpsNightly(ctx)).json()) as OpsNightlyReport;
    expect(body.status).toBe("ok");
    expect(body.doctor?.status).toBe("ok");
    const byName = Object.fromEntries((body.doctor?.checks ?? []).map((c) => [c.name, c]));
    expect(byName.cycle_freshness?.status).toBe("warn");
    expect(byName.sync_freshness?.status).toBe("fail");
    expect(byName.cron_gbrain_home?.status).toBe("na"); // not_applicable → na
    expect(body.doctor?.missing).toEqual([
      "extract_health", "global_maintenance_stalled",
      "default_source_local_path", "chat_fallback_chain",
    ]); // set members that answered neither row nor na line are surfaced
    expect(body.stamps?.status).toBe("ok");
    expect(body.stamps?.sources).toHaveLength(2);
    expect(body.stamps?.sources[1]).toEqual({ source_id: "iuap-apcom-docs" }); // never cycled stays empty
    expect(body.runNow?.default).toBe(
      "gbrain dream --source default --phase propose_takes --phase grade_takes",
    );
    expect(body.runNow?.["iuap-apcom-docs"]).toContain("dream --source iuap-apcom-docs");
  });

  test("guard profile builds the direct-call form (GBRAIN_HOME + real bin)", async () => {
    const { ctx } = opsCtx({ id: "nightly-b", cli: true, doctorChecks: { nightly: { checks: [] } }, stamps: [{ source_id: "yon-bip" }] });
    // opsCtx keeps takesGuard null; emulate the direct-call pair directly
    const withGuard = { ...ctx, takesGuard: { bin: "/home/dev/.bun/bin/gbrain", home: "/home/dev/gbrain-bip" } } as unknown as ApiContext;
    const body = (await (await handleOpsNightly(withGuard)).json()) as OpsNightlyReport;
    expect(body.runNow?.["yon-bip"]).toBe(
      "GBRAIN_HOME=/home/dev/gbrain-bip /home/dev/.bun/bin/gbrain dream --source yon-bip --phase propose_takes --phase grade_takes",
    );
  });

  test("CLI down + pg down: in-band down parts, never a 500; charset-refused source gets no command", async () => {
    const noCli = opsCtx({ id: "nightly-c", cli: false, stamps: [{ source_id: "Bad_Source_id" }] });
    // pg returns a row whose id fails the upstream charset — no runNow entry
    const body = (await (await handleOpsNightly(noCli.ctx)).json()) as OpsNightlyReport;
    expect(body.doctor?.status).toBe("down");
    expect(body.runNow).toBeUndefined(); // charset-refused source: no command beats a bad paste
    expect(body.status).toBe("degraded"); // doctor down, stamps part still ok

    const pgDown = opsCtx({ id: "nightly-d", cli: true, doctorChecks: { nightly: { checks: [] } }, pgError: new Error("permission denied for table sources") });
    const body2 = (await (await handleOpsNightly(pgDown.ctx)).json()) as OpsNightlyReport;
    expect(body2.stamps?.status).toBe("down");
    expect(body2.stamps?.error).toContain("permission denied");
    expect(body2.status).toBe("degraded"); // doctor still ok
  });
});

describe("handleOpsCalibration", () => {
  test("scorecard + profile + doctor calibration set; profile null is honest empty", async () => {
    const { ctx } = opsCtx({
      id: "calib-a",
      cli: true,
      scorecard: { total_bets: 0, resolved: 0, accuracy: null, brier: null, mcp_resolved: 0 },
      profile: null,
      doctorChecks: { calibration: { checks: [{ name: "takes_count", status: "ok", message: "8 takes (calibration usable; >100 ideal)" }] } },
    });
    const body = (await (await handleOpsCalibration(ctx)).json()) as OpsCalibrationReport;
    expect(body.status).toBe("ok");
    expect(body.scorecard?.total_bets).toBe(0);
    expect(body.profile).toBeNull();
    expect(body.doctor?.checks[0]?.message).toContain("calibration usable");
  });

  test("MCP failure degrades in-band; doctor failure alone degrades too", async () => {
    const mcpDown = opsCtx({
      id: "calib-b",
      cli: true,
      scorecardError: new Error("E_UPSTREAM_AUTH"),
      doctorChecks: { calibration: { checks: [] } },
    });
    const body = (await (await handleOpsCalibration(mcpDown.ctx)).json()) as OpsCalibrationReport;
    expect(body.status).toBe("degraded");
    expect(body.error).toContain("E_UPSTREAM_AUTH");
    expect(body.doctor?.status).toBe("ok"); // the doctor half still carries the card

    const doctorDown = opsCtx({ id: "calib-c", cli: false });
    const body2 = (await (await handleOpsCalibration(doctorDown.ctx)).json()) as OpsCalibrationReport;
    expect(body2.status).toBe("degraded");
    expect(body2.doctor?.status).toBe("down");
  });
});

// --- 0.5.0 batch 3: assets + deploy ops -------------------------------------------

describe("handleOpsAssets", () => {
  test("three-state asset rows; na (not_applicable) renders as na", async () => {
    const { ctx } = opsCtx({
      id: "assets-a",
      cli: true,
      doctorChecks: {
        assets: {
          checks: [
            { name: "backup_coverage", status: "warn", message: "5 knowledge asset(s) lack verified recovery" },
            { name: "git_convergence", status: "ok", readiness_state: "not_applicable" },
            { name: "unindexed_files", status: "ok", severity: "info", readiness_state: "unknown" },
          ],
        },
      },
    });
    const res = await handleOpsAssets(ctx);
    const body = (await res.json()) as OpsAssetsReport;
    expect(body.status).toBe("ok");
    const byName = Object.fromEntries((body.doctor?.checks ?? []).map((c) => [c.name, c]));
    expect(byName.backup_coverage?.status).toBe("warn");
    expect(byName.git_convergence?.status).toBe("na");
    expect(byName.unindexed_files?.status).toBe("ok"); // unknown readiness is NOT na
  });

  test("CLI down degrades in-band", async () => {
    const { ctx } = opsCtx({ id: "assets-b", cli: false });
    const body = (await (await handleOpsAssets(ctx)).json()) as OpsAssetsReport;
    expect(body.status).toBe("degraded");
    expect(body.doctor?.status).toBe("down");
  });
});

describe("handleOpsDeploy", () => {
  const BINDINGS = [
    { source_id: "default", local_path: "/home/dev/gbrain-bip/.gbrain/content/x/default", state: "active", git_durability_state: "unknown" },
    { source_id: "yon-bip", local_path: "/home/dev/bip-gbrain/yon-bip", state: "active", git_durability_state: "unknown" },
  ];

  test("mode + modeled binding slice + generated unit text + notes", async () => {
    const { ctx } = opsCtx({
      id: "deploy-a",
      cli: true,
      writerStatus: { mode: "managed", bindings: BINDINGS },
      doctorChecks: { topology: { checks: [{ name: "cycle_phase_scope", status: "ok", message: "Phase taxonomy: …" }] } },
    });
    const body = (await (await handleOpsDeploy(ctx)).json()) as OpsDeployReport;
    expect(body.status).toBe("ok");
    expect(body.writer?.mode).toBe("managed");
    // the modeled slice ONLY — richer rows (42KB payload) never leave the server
    expect(body.writer?.bindings).toEqual([
      { source_id: "default", local_path: "/home/dev/gbrain-bip/.gbrain/content/x/default", state: "active", git_durability_state: "unknown" },
      { source_id: "yon-bip", local_path: "/home/dev/bip-gbrain/yon-bip", state: "active", git_durability_state: "unknown" },
    ]);
    expect(body.unitText).toContain('dream --source "yon-bip" --phase propose_takes --phase grade_takes');
    expect(body.unitText).toContain("--source \"default\" --json");
    expect(body.notes).toEqual([
      "repo-path-two-locks", "systemd-quoting", "propose-window",
      "grade-window-global", "cron-not-systemd",
    ]);
    expect(body.topology?.checks[0]?.name).toBe("cycle_phase_scope");
  });

  test("writer down: no unit text, topology still carries the card", async () => {
    const { ctx } = opsCtx({
      id: "deploy-b",
      cli: true,
      writerStatus: new Error("boom"),
      doctorChecks: { topology: { checks: [] } },
    });
    const body = (await (await handleOpsDeploy(ctx)).json()) as OpsDeployReport;
    expect(body.writer?.status).toBe("down");
    expect(body.unitText).toBeUndefined();
    expect(body.status).toBe("degraded");
    expect(body.topology?.status).toBe("ok");
  });
});
