import {
  ASK_THINK_SECONDS_MAX,
  type AskCitation,
  type AskEvidenceRow,
  type AskThinkResult,
} from "@gbrain-cockpit/shared";

// 问一句 tape logic — pure, no React, no fetch. Everything the Ask panel
// renders through lives here so the tape's semantics are testable without a
// browser: citation classification (§5), [slug] marker splitting, evidence
// title/excerpt extraction (§6), wait-clock tiers (§7), enum picklists (§10).
// Shape truths come from internal/probes/ask-panel-0.60.611-20261113.json.

/** A slug that can appear inside `[…]` markers in answer/gap text. Must be
 *  slug-shaped (no spaces — keeps "[quoted conversation excerpt …]" style
 *  prose OUT of chip parsing even before the known-slug filter). */
export const SLUG_MARKER_RE = /^[a-zA-Z0-9][a-zA-Z0-9/_.-]{0,200}$/;

// --- citation classification (design §5) ---------------------------------------

export type ChipKind = "tape" | "brain" | "gap";

export interface ChipRef {
  slug: string;
  kind: ChipKind;
  /** citation_index when the slug is in citations[]; null → gap-only (`—`) */
  index: number | null;
  /** source_id from the citation row / evidence row when known */
  sourceId?: string;
}

/**
 * Classify every citable slug on one tape:
 *  - `tape`  — the slug is one of THIS tape's query evidence rows (solid
 *    chip; hover shows the row's real chunk_text excerpt, click jumps to it)
 *  - `brain` — only in citations[] (dashed chip; the brain read it while
 *    writing, the free leg carries no excerpt for it)
 *  - `gap`   — only cited inside gaps[] sentences (probed live: pzqy-36089)
 */
export function classifyCitations(
  rows: AskEvidenceRow[],
  result: AskThinkResult,
): Map<string, ChipRef> {
  const map = new Map<string, ChipRef>();
  for (const row of rows) {
    map.set(row.slug, {
      slug: row.slug,
      kind: "tape",
      index: null,
      ...(row.source_id !== undefined ? { sourceId: row.source_id } : {}),
    });
  }
  const bySlug = new Map<string, AskCitation>();
  for (const c of result.citations) bySlug.set(c.page_slug, c);
  for (const c of result.citations) {
    const tape = map.get(c.page_slug);
    if (tape) {
      tape.index = c.citation_index;
      if (tape.sourceId === undefined && c.source_id !== undefined) {
        tape.sourceId = c.source_id;
      }
      continue;
    }
    map.set(c.page_slug, {
      slug: c.page_slug,
      kind: "brain",
      index: c.citation_index,
      ...(c.source_id !== undefined ? { sourceId: c.source_id } : {}),
    });
  }
  for (const slug of gapOnlySlugs(result, map)) {
    map.set(slug, { slug, kind: "gap", index: null });
  }
  return map;
}

/** slugs referenced inside gap sentences but absent from rows+citations */
function gapOnlySlugs(
  result: AskThinkResult,
  known: Map<string, ChipRef>,
): string[] {
  const found: string[] = [];
  for (const gap of result.gaps) {
    for (const slug of markerSlugs(gap)) {
      if (!known.has(slug) && !found.includes(slug)) found.push(slug);
    }
  }
  return found;
}

// --- [slug] marker splitting ----------------------------------------------------

export type TextRun = { text: string } | { slug: string };

/** Split a plain-text run on `[slug]` markers. Unknown brackets (anything not
 *  slug-shaped) survive verbatim — no guessing, no eaten prose. */
export function splitSlugMarkers(text: string): TextRun[] {
  const runs: TextRun[] = [];
  let rest = text;
  let buf = "";
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] !== "[") {
      buf += rest[i];
      continue;
    }
    const close = rest.indexOf("]", i + 1);
    if (close === -1) {
      buf += rest.slice(i);
      break;
    }
    const inner = rest.slice(i + 1, close);
    if (!SLUG_MARKER_RE.test(inner)) {
      buf += rest.slice(i, close + 1);
      i = close;
      continue;
    }
    if (buf) {
      runs.push({ text: buf });
      buf = "";
    }
    runs.push({ slug: inner });
    i = close;
  }
  if (buf) runs.push({ text: buf });
  return runs;
}

/** every slug-shaped `[…]` marker inside a text (used for gap-only discovery) */
export function markerSlugs(text: string): string[] {
  return splitSlugMarkers(text)
    .filter((r): r is { slug: string } => "slug" in r)
    .map((r) => r.slug);
}

// --- chip label (§5: `序号·页尾`) ------------------------------------------------

/** last path segment ("kb/migration0068" → "migration0068") */
export function slugTail(slug: string): string {
  const slash = slug.lastIndexOf("/");
  return slash === -1 ? slug : slug.slice(slash + 1);
}

/** chip label tail (§5): the trailing digit run of the last segment
 *  ("migration0068" → "0068", "pzqy-36064" → "36064" — the mockup's 页尾),
 *  falling back to the whole last segment when it ends in letters. */
export function chipTail(slug: string): string {
  const tail = slugTail(slug);
  const digits = /(\d+)$/.exec(tail);
  return digits?.[1] ?? tail;
}

/** chip label: `1·0068` on-tape/brain-read, `—·36089` gap-only */
export function chipLabel(ref: ChipRef): string {
  return `${ref.index === null ? "—" : ref.index}·${chipTail(ref.slug)}`;
}

// --- evidence row extraction (§6) ------------------------------------------------

/**
 * Display title: the first line inside the title's ```text fence when the
 * title carries one (the ingest wrapper's human headline), else the title as
 * stored (plain text either way — never rendered as markdown).
 */
export function evidenceTitle(title: string): string {
  const m = /```(?:text)?\s*\n(.+)/.exec(title);
  return (m?.[1] ?? title).trim();
}

export interface ExcerptParts {
  /** the "[quoted conversation excerpt …]" provenance cap, when leading */
  cap?: string;
  /** the excerpt body (still raw — rendered pre-wrap, never markdown) */
  body: string;
}

/**
 * Split a chunk_text excerpt: when the first line is the upstream injection
 * guard wrapper, it becomes a dim cap line and the rest is the body. Strict
 * anchor ("[quoted …]" prefix) — everything else is body, as stored.
 */
export function splitExcerpt(chunkText: string): ExcerptParts {
  const text = chunkText.replace(/\s+$/, "");
  const nl = text.indexOf("\n");
  if (nl === -1) return { body: text };
  const first = text.slice(0, nl).trim();
  if (first.startsWith("[quoted conversation excerpt")) {
    return { cap: first, body: text.slice(nl + 1) };
  }
  return { body: text };
}

// --- wait clock (§7: thresholds 60s / 95s, measured range 36–95s) ----------------

export type WaitTier = 0 | 1 | 2;

export function waitTier(elapsedMs: number): WaitTier {
  const s = elapsedMs / 1000;
  if (s < 60) return 0;
  if (s <= ASK_THINK_SECONDS_MAX) return 1;
  return 2;
}

/** mm:ss, tabular-friendly (the clock renders it in mono anyway) */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/** seconds with one decimal for segment meta / colophons ("2.4", "94.8") */
export function formatSeconds(ms: number): string {
  return (ms / 1000).toFixed(1);
}

// --- state derivation (§4) -------------------------------------------------------

/**
 * The 答不出 variant: machine-honest rule — the FREE leg had nothing to print
 * (0 rows) and the paid leg still completed. We cannot parse answer semantics;
 * an empty evidence table + a finished tape is the only structurally honest
 * signal, so that is what flips the stamp (NOT ANSWERED + the honesty lede).
 */
export function isNoAnswer(rows: AskEvidenceRow[]): boolean {
  return rows.length === 0;
}

// --- enum picklists (§10: known values get human labels, unknown pass through) ---

export const KNOWN_TYPES = ["knowledge", "issue-record", "experience"] as const;
export const KNOWN_TRUST_TIERS = [
  "user_confirmed",
  "operator_curated",
  "tool_observed",
  "agent_written",
  "unknown",
  "external_untrusted",
] as const;

/** "10-19" from "2026-10-19"; the full date rides a title attribute. */
export function shortDate(effectiveDate: string | undefined): string {
  if (!effectiveDate || effectiveDate.length < 10) return effectiveDate ?? "";
  return effectiveDate.slice(5, 10);
}

/** tokens with thousands separators ("3,763") — odometers are tabular-nums */
export function fmtNum(n: number | undefined): string {
  return n === undefined ? "—" : n.toLocaleString("en-US");
}
