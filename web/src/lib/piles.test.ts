import { describe, expect, test } from "bun:test";
import {
  PILE_MEMBERS,
  batchablePage,
  batchablePageRelief,
  dedupeDpTwins,
  pileOf,
  pileTabCount,
  reliefCounts,
  reliefKeeps,
  reliefPileCount,
  reliefView,
  sidebarTotal,
  type QueueId,
} from "./piles";
import type { TakeProposal, TakesRelief } from "@gbrain-cockpit/shared";

describe("pile membership (0.5.0 three-pile model)", () => {
  test("every queue belongs to exactly one pile — the partition is total", () => {
    const all: QueueId[] = [
      "proposals", "held", "facts", "edges", "takes",
      "contradictions", "extraction", "judgments", "others",
    ];
    const seen = new Set<QueueId>();
    for (const pile of Object.keys(PILE_MEMBERS) as Array<keyof typeof PILE_MEMBERS>) {
      for (const q of PILE_MEMBERS[pile]) {
        expect(seen.has(q)).toBe(false);
        seen.add(q);
        expect(pileOf(q)).toBe(pile);
      }
    }
    expect([...seen].sort()).toEqual([...all].sort());
  });
});

describe("dedupeDpTwins (upstream: one decide_proposal, two channels)", () => {
  test("dp twins matching a decide-queue id are dropped; strangers stay", () => {
    const trust = [
      { ref: "tp1" },
      { ref: "dp7" }, // twin of decide #7 → dropped
      { ref: "dp9" }, // no decide row #9 → stays (decide channel down/empty)
    ];
    const decide = [{ id: 7 }, { id: "12" }];
    expect(dedupeDpTwins(trust, decide).map((i) => i.ref)).toEqual([
      "tp1",
      "dp9",
    ]);
  });

  test("string-serialized decide ids (bigint upstream) match their dp twins", () => {
    expect(dedupeDpTwins([{ ref: "dp12" }], [{ id: "12" }])).toEqual([]);
  });

  test("empty decide queue keeps every dp twin (the fallback lane)", () => {
    expect(dedupeDpTwins([{ ref: "dp7" }], []).map((i) => i.ref)).toEqual(["dp7"]);
  });
});

describe("batchablePage (mixed pile pages hide the batch button)", () => {
  test("pure takes page and pure edges page are batchable", () => {
    expect(batchablePage([{ queueId: "takes" }, { queueId: "takes" }])).toBe(true);
    expect(batchablePage([{ queueId: "edges" }])).toBe(true);
  });

  test("judgments (MCP resolve) and contradictions break the batch", () => {
    expect(batchablePage([{ queueId: "takes" }, { queueId: "judgments" }])).toBe(false);
    expect(batchablePage([{ queueId: "contradictions" }])).toBe(false);
  });

  test("empty pages are never batchable", () => {
    expect(batchablePage([])).toBe(false);
  });
});

describe("pileTabCount + sidebarTotal (counting discipline)", () => {
  const counts: Record<QueueId, number> = {
    proposals: 2, held: 1, facts: 0, edges: 4, takes: 176,
    contradictions: 0, extraction: 3, judgments: 24, others: 0,
  };

  test("pile counts are member sums", () => {
    expect(pileTabCount("viewpoint", counts, {})).toBe(200);
    expect(pileTabCount("trust", counts, {})).toBe(3);
    expect(pileTabCount("verdict", counts, {})).toBe(4);
    expect(pileTabCount("stubs", counts, {})).toBe(3);
  });

  test("any member channel down marks the pile ?", () => {
    expect(pileTabCount("viewpoint", counts, { takes: "pg down" })).toBe("?");
    expect(pileTabCount("trust", counts, { others: "cli down" })).toBe("?");
  });

  test("sidebar total keeps the pre-pile exclusion set (extraction/judgments out)", () => {
    expect(sidebarTotal(counts)).toBe(183);
  });
});

// --- 0.5.2 inbox relief -----------------------------------------------------------

describe("relief view (0.5.2: pile default view, mutes, snoozes)", () => {
  const relief: TakesRelief = {
    piles: [
      { source: "main", since: "2026-11-04T18:00:00Z", night: "2026-11-04T18:07:00Z", count: 2, ids: [4, 5] },
      { source: "archive", since: "2026-11-02T18:00:00Z", night: "2026-11-02T18:01:00Z", count: 1, ids: [9] },
    ],
    snoozed: [{ id: 5, source: "main" }],
    muted: ["archive"],
    mutedCounts: { archive: 1 },
  };
  const view = reliefView(relief)!;

  test("reliefKeeps: pile minus snoozed minus muted; non-takes always stay", () => {
    expect(view).not.toBeNull();
    expect(reliefKeeps({ queueId: "takes", sourceId: "main", item: { id: 4 } }, view)).toBe(true);
    expect(reliefKeeps({ queueId: "takes", sourceId: "main", item: { id: 5 } }, view)).toBe(false); // snoozed
    expect(reliefKeeps({ queueId: "takes", sourceId: "archive", item: { id: 9 } }, view)).toBe(false); // muted
    expect(reliefKeeps({ queueId: "takes", sourceId: "main", item: { id: 1 } }, view)).toBe(false); // backlog
    expect(reliefKeeps({ queueId: "edges", item: { id: 1 } }, view)).toBe(true); // non-takes
  });

  test("reliefCounts buckets are disjoint and total to the pending length", () => {
    const items: TakeProposal[] = [
      { id: 4, source_id: "main", page_slug: "a", claim_text: "c" },
      { id: 5, source_id: "main", page_slug: "a", claim_text: "c" },
      { id: 9, source_id: "archive", page_slug: "a", claim_text: "c" },
      { id: 1, source_id: "main", page_slug: "a", claim_text: "c" }, // backlog
      { id: 2, source_id: "main", page_slug: "a", claim_text: "c" }, // backlog
    ];
    expect(reliefCounts(items, view)).toEqual({ pile: 1, snoozed: 1, muted: 1, backlog: 2 });
    expect(reliefPileCount(items, view)).toBe(1);
  });

  test("queueCounts stay FULL — displayCounts only (sidebar semantics pinned)", () => {
    // the relief view changes what the DESK shows, never what sidebarTotal
    // counts: full takes length keeps feeding the sidebar in both views.
    const items: TakeProposal[] = [
      { id: 4, source_id: "main", page_slug: "a", claim_text: "c" },
      { id: 1, source_id: "main", page_slug: "a", claim_text: "c" },
      { id: 2, source_id: "main", page_slug: "a", claim_text: "c" },
    ];
    const queueCounts: Record<QueueId, number> = {
      proposals: 0, held: 0, facts: 0, edges: 0,
      takes: items.length, contradictions: 0, extraction: 0, judgments: 0, others: 0,
    };
    expect(sidebarTotal(queueCounts)).toBe(3); // untouched by the relief view
  });

  test("batchablePageRelief: a page holding a HIDDEN take hides the batch button", () => {
    const clean = [
      { queueId: "takes" as QueueId, sourceId: "main", item: { id: 4 } },
      { queueId: "takes" as QueueId, sourceId: "main", item: { id: 6 } },
    ];
    expect(batchablePageRelief(clean, view)).toBe(true);
    const withSnoozed = [
      { queueId: "takes" as QueueId, sourceId: "main", item: { id: 4 } },
      { queueId: "takes" as QueueId, sourceId: "main", item: { id: 5 } }, // snoozed
    ];
    expect(batchablePageRelief(withSnoozed, view)).toBe(false);
    const withMuted = [
      { queueId: "takes" as QueueId, sourceId: "archive", item: { id: 9 } }, // muted source
    ];
    expect(batchablePageRelief(withMuted, view)).toBe(false);
    // no relief wired ⇒ the 0.5.0 gate unchanged
    expect(batchablePageRelief(withSnoozed, null)).toBe(true);
  });

  test("reliefView of nothing is null (pre-0.5.2 deployments keep the full list)", () => {
    expect(reliefView(undefined)).toBeNull();
    expect(reliefView(null)).toBeNull();
  });
});
