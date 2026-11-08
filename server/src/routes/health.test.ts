import { describe, expect, test } from "bun:test";
import { cliReason, getHealthReport, normalizeWhoami } from "./health";
import type { BrainChannels } from "../brains";
import type { CliDriver } from "../drivers/cli";
import { McpDriver } from "../drivers/mcp";
import { PgReadonlyDriver } from "../drivers/pg-readonly";

// Health assembly per profile: the whoami normalizer covers all three
// 0.60.558 transports, and the report cache is keyed per profile — the
// module-level single cache used to hand one brain's whoami to the other.

function fakeMcp(whoami: Record<string, unknown> | "fail") {
  return (async (_input: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      method?: string;
    };
    if (body.method === "initialize") {
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), {
        headers: { "content-type": "application/json" },
      });
    }
    if (body.method === "tools/call" && whoami !== "fail") {
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: { content: [{ type: "text", text: JSON.stringify(whoami) }] },
        }),
        { headers: { "content-type": "application/json" } },
      );
    }
    return new Response("down", { status: 503 });
  }) as typeof fetch;
}

function channels(
  id: string,
  whoami: Record<string, unknown> | "fail",
): BrainChannels {
  return {
    id,
    profile: {
      id,
      name: `brain-${id}`,
      mcpUrl: `http://${id}/mcp`,
      mcpToken: "t",
    },
    mcp: new McpDriver({
      url: `http://${id}/mcp`,
      token: "t",
      fetchFn: fakeMcp(whoami),
    }),
    cli: null,
    pg: new PgReadonlyDriver({ dsn: null }),
    takesGuard: null,
    cliBinResolved: null,
  };
}

describe("normalizeWhoami (0.60.558 per-transport shapes)", () => {
  test("legacy bearer: token_name becomes client", () => {
    const out = normalizeWhoami({
      transport: "legacy",
      token_name: "cockpit-ui",
      scopes: ["read"],
    });
    expect(out.client).toBe("cockpit-ui");
  });

  test("oauth grant: client_name / client_id fill in (no token_name exists)", () => {
    const out = normalizeWhoami({
      transport: "oauth",
      client_id: "ci-1",
      client_name: "cockpit-ui",
      scopes: ["read"],
      source_id: "main",
      federated_read: ["main"],
    });
    expect(out.client).toBe("cockpit-ui");
    const fallback = normalizeWhoami({ transport: "oauth", client_id: "ci-2" });
    expect(fallback.client).toBe("ci-2");
  });

  test("explicit client wins untouched", () => {
    expect(normalizeWhoami({ client: "already-set" }).client).toBe("already-set");
  });
});

describe("getHealthReport (per-profile cache)", () => {
  test("reports carry their profile identity and never bleed across ids", async () => {
    const a = await getHealthReport(channels("alpha", { token_name: "alpha-tok" }));
    const b = await getHealthReport(channels("beta", { client_name: "beta-tok" }));
    expect(a.profile).toEqual({ id: "alpha", name: "brain-alpha" });
    expect(b.profile).toEqual({ id: "beta", name: "brain-beta" });
    expect(a.checks.mcp.whoami?.client).toBe("alpha-tok");
    expect(b.checks.mcp.whoami?.client).toBe("beta-tok");
    // cached second read stays per-profile
    const a2 = await getHealthReport(channels("alpha", "fail"));
    expect(a2.checks.mcp.status).toBe("ok"); // served from alpha's cache
    expect(a2.checks.mcp.whoami?.client).toBe("alpha-tok");
  });

  test("mcp down marks the whole report down, in-band", async () => {
    const report = await getHealthReport(channels("gamma", "fail"));
    expect(report.status).toBe("down");
    expect(report.checks.mcp.status).toBe("down");
    expect(report.checks.brain.status).toBe("down");
  });
});

describe("cliReason (the shared why-unavailable vocabulary)", () => {
  test("maps driver presence + probe outcome to the Health card's reasons", () => {
    const driver = {} as CliDriver; // presence is all cliReason reads
    expect(cliReason(null, false)).toBe("binary-not-found");
    expect(cliReason(driver, true)).toBe("binary-verified");
    expect(cliReason(driver, false)).toBe("binary-found-unverified");
  });
});
