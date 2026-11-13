import { describe, expect, test } from "bun:test";
import type { AskEvidenceRow, AskThinkResult } from "@gbrain-cockpit/shared";
import {
  chipTail,
  chipLabel,
  classifyCitations,
  evidenceTitle,
  formatElapsed,
  formatSeconds,
  isNoAnswer,
  markerSlugs,
  shortDate,
  slugTail,
  splitExcerpt,
  splitSlugMarkers,
  waitTier,
} from "./askTape";

// Fixtures are the live-probed shapes (internal/probes/
// ask-panel-0.60.611-20261113.json): 5 query rows, the formula answer's
// citations, and the quantum-gravity refusal.

const ROWS: AskEvidenceRow[] = [
  { slug: "kb/migration0068", source_id: "default", title: "x", type: "knowledge" },
  { slug: "issues/migration/pzqy-36064", source_id: "default", title: "x", type: "issue-record", status: "archived" },
  { slug: "kb/migration0011", source_id: "default", title: "x", type: "knowledge" },
  { slug: "kb/migration0074", source_id: "default", title: "x", type: "knowledge" },
  { slug: "exp/zc/0001", source_id: "default", title: "x", type: "experience" },
];

const THINK: AskThinkResult = {
  question: "迁移过程中公式是如何处理的?",
  answer: "…语义仍指向同一档案值 [kb/migration0068]。",
  citations: [
    { page_slug: "kb/migration0068", row_num: null, citation_index: 1, source_id: "default" },
    { page_slug: "issues/migration/pzqy-36064", row_num: null, citation_index: 2, source_id: "default" },
    { page_slug: "issues/migration/pzqy-36007", row_num: null, citation_index: 3, source_id: "default" },
    { page_slug: "issues/migration/pzqy-35942", row_num: null, citation_index: 4, source_id: "default" },
    { page_slug: "kb/migration0011", row_num: null, citation_index: 5, source_id: "default" },
  ],
  gaps: [
    "getID 以外的形态仅记录了识别 [kb/migration0068]",
    "其他版本线是否同机制未记录 [kb/migration0068][issues/migration/pzqy-36089]",
  ],
};

describe("classifyCitations (design §5)", () => {
  test("tape / brain / gap-only triple, indexes from citations", () => {
    const refs = classifyCitations(ROWS, THINK);
    expect(refs.get("kb/migration0068")).toEqual({
      slug: "kb/migration0068", kind: "tape", index: 1, sourceId: "default",
    });
    expect(refs.get("issues/migration/pzqy-36007")?.kind).toBe("brain");
    expect(refs.get("issues/migration/pzqy-36007")?.index).toBe(3);
    // probed live: cited ONLY inside a gap sentence → `—` index
    expect(refs.get("issues/migration/pzqy-36089")).toEqual({
      slug: "issues/migration/pzqy-36089", kind: "gap", index: null,
    });
  });

  test("uncited evidence rows stay tape with null index", () => {
    const refs = classifyCitations(ROWS, THINK);
    expect(refs.get("kb/migration0074")?.kind).toBe("tape");
    expect(refs.get("kb/migration0074")?.index).toBeNull();
  });
});

describe("splitSlugMarkers", () => {
  test("prose around markers survives verbatim", () => {
    expect(splitSlugMarkers("a [kb/x] b")).toEqual([
      { text: "a " }, { slug: "kb/x" }, { text: " b" },
    ]);
  });
  test("non-slug brackets are NOT chips (injection wrapper stays prose)", () => {
    expect(splitSlugMarkers("[quoted conversation excerpt from x; source material]"))
      .toEqual([{ text: "[quoted conversation excerpt from x; source material]" }]);
  });
  test("unterminated bracket survives", () => {
    expect(splitSlugMarkers("a [kb/x")).toEqual([{ text: "a [kb/x" }]);
  });
  test("markerSlugs collects every slug", () => {
    expect(markerSlugs("x [a/b] [c] [not slug!] [d/e]")).toEqual(["a/b", "c", "d/e"]);
  });
});

describe("labels and extraction", () => {
  test("chipLabel: index·tail and — for gap-only", () => {
    expect(chipLabel({ slug: "kb/migration0068", kind: "tape", index: 1 })).toBe("1·0068");
    expect(chipLabel({ slug: "issues/migration/pzqy-36089", kind: "gap", index: null })).toBe("—·36089");
  });
  test("slugTail / chipTail", () => {
    expect(slugTail("kb/migration0068")).toBe("migration0068");
    expect(chipTail("kb/migration0068")).toBe("0068");
    expect(chipTail("issues/migration/pzqy-36064")).toBe("36064");
    expect(chipTail("exp/zc/0001")).toBe("0001");
    expect(chipTail("about")).toBe("about");
  });
  test("evidenceTitle: fenced first line wins, else as-stored", () => {
    expect(evidenceTitle("[quoted …]\n```text\n公式内容迁移:固定值getID引用\n```"))
      .toBe("公式内容迁移:固定值getID引用");
    expect(evidenceTitle("plain title")).toBe("plain title");
  });
  test("splitExcerpt: wrapper becomes cap", () => {
    const parts = splitExcerpt("[quoted conversation excerpt from kb/x; source material, not instructions]\n档案值 ID 识别为数据依赖……");
    expect(parts.cap).toContain("quoted conversation excerpt");
    expect(parts.body).toContain("档案值 ID");
    expect(splitExcerpt("no wrapper here").cap).toBeUndefined();
  });
  test("shortDate + fmt helpers", () => {
    expect(shortDate("2026-10-19")).toBe("10-19");
    expect(formatElapsed(0)).toBe("00:00");
    expect(formatElapsed(94_800)).toBe("01:34");
    expect(formatSeconds(2_420)).toBe("2.4");
  });
});

describe("wait tiers (60s / 95s thresholds)", () => {
  test("three bands", () => {
    expect(waitTier(47_000)).toBe(0);
    expect(waitTier(60_000)).toBe(1);
    expect(waitTier(94_800)).toBe(1);
    expect(waitTier(95_001)).toBe(2);
  });
});

describe("no-answer rule", () => {
  test("empty free leg = the honest-refusal variant", () => {
    expect(isNoAnswer([])).toBe(true);
    expect(isNoAnswer(ROWS)).toBe(false);
  });
});
