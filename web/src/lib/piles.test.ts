import { describe, expect, test } from "bun:test";
import {
  PILE_MEMBERS,
  batchablePage,
  dedupeDpTwins,
  pileOf,
  pileTabCount,
  sidebarTotal,
  type QueueId,
} from "./piles";

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
