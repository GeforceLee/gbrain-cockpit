import type {
  ContradictionProposal,
  TakeProposal,
  TakesRelief,
  TrustReviewItem,
} from "@gbrain-cockpit/shared";

// 0.5.0 three-pile model (owner-approved): pure logic extracted from the
// Inbox component so the hidden state changes ride pinned tests — pile
// membership, the dp-twin dedup, the batch gate and the pile tab count.
// Presentation grouping ONLY: every queue keeps its own channel and rail.

export type QueueId =
  | "proposals"
  | "held"
  | "facts"
  | "edges"
  | "takes"
  | "contradictions"
  | "extraction"
  | "judgments"
  | "others";

export type TabId = "all" | "viewpoint" | "trust" | "verdict" | "stubs";

export type PileId = Exclude<TabId, "all">;

export const PILE_MEMBERS: Record<PileId, readonly QueueId[]> = {
  viewpoint: ["takes", "judgments"],
  trust: ["proposals", "held", "facts", "others"],
  verdict: ["edges", "contradictions"],
  stubs: ["extraction"],
};

export function pileOf(queueId: QueueId): PileId {
  for (const [pile, members] of Object.entries(PILE_MEMBERS)) {
    if ((members as readonly QueueId[]).includes(queueId)) {
      return pile as PileId;
    }
  }
  return "trust"; // unreachable — every queue is a member
}

/**
 * dp-twin dedup (upstream-verified 0.60.611): one pending decide_proposal
 * appears BOTH in trust review (ref `dp<id>`, kind contradiction) AND in
 * the decide proposals queue. The decide row wins (richer, its own verbs);
 * the dp twin only carries the lane while the decide channel is down or
 * empty — so the verdict pile never counts one proposal twice.
 */
export function dedupeDpTwins(
  trustItems: TrustReviewItem[],
  decideProposals: ContradictionProposal[],
): TrustReviewItem[] {
  const decideIds = new Set(decideProposals.map((p) => String(p.id ?? "")));
  return trustItems.filter((i) => {
    const ref = i.ref ?? "";
    return ref.startsWith("dp") ? !decideIds.has(ref.slice(2)) : true;
  });
}

/**
 * The batch-reject gate (0.5.0 rule): the page button exists only when EVERY
 * entry on the page is a batchable queue (takes/edges, CLI one-key channel).
 * Judgments resolve over MCP (never batched) and contradictions carry no
 * batch form — a mixed pile page simply hides the button.
 */
export function batchablePage(entries: Array<{ queueId: QueueId }>): boolean {
  return (
    entries.length > 0 &&
    entries.every((e) => e.queueId === "takes" || e.queueId === "edges")
  );
}

/**
 * The pile tab count: member sum; "?" when ANY member channel is down —
 * channel-down is not zero, and the pile must not fake confidence.
 */
export function pileTabCount(
  pile: PileId,
  counts: Record<QueueId, number>,
  down: Partial<Record<QueueId, string>>,
): number | "?" {
  const members = PILE_MEMBERS[pile];
  if (members.some((q) => down[q] !== undefined)) return "?";
  return members.reduce((sum, q) => sum + (counts[q] ?? 0), 0);
}

/**
 * The sidebar total keeps the pre-pile exclusion set on purpose (extraction
 * and judgments never counted) — pinned here so the collapse cannot drift
 * the sidebar silently.
 */
export function sidebarTotal(counts: Record<QueueId, number>): number {
  return (
    counts.proposals +
    counts.held +
    counts.facts +
    counts.edges +
    counts.takes +
    counts.contradictions +
    counts.others
  );
}

// --- 0.5.2 inbox relief (「收件箱,住得下」) ---------------------------------
// The default view keeps only each source's newest pending batch (the pile);
// mutes and snoozes hide entries until reversed or auto-revived. PURE view
// logic over the server's relief part — the server owns pile membership
// (computeTakePiles) and state truth; this layer only slices. queueCounts
// (the sidebar's diet) stays FULL in every view — the pile count is a
// displayCount, never a queueCount (pinned: the sidebar must not change
// meaning when the relief view lands).

/** Precomputed membership sets for one takes.relief payload. */
export interface ReliefView {
  pileIds: Set<number>;
  muted: Set<string>;
  snoozed: Set<number>;
}

export function reliefView(relief: TakesRelief | null | undefined): ReliefView | null {
  if (!relief) return null;
  return {
    pileIds: new Set(relief.piles.flatMap((p) => p.ids)),
    muted: new Set(relief.muted),
    snoozed: new Set(relief.snoozed.map((s) => s.id)),
  };
}

export interface ReliefEntryLike {
  queueId: QueueId;
  sourceId?: string | null;
  item?: unknown;
}

function takeIdOf(entry: ReliefEntryLike): number {
  const item = entry.item as { id?: number | string } | undefined;
  return typeof item?.id === "number" ? item.id : Number(item?.id ?? NaN);
}

/** True when a take entry stays in the relief default view. Non-takes stay. */
export function reliefKeeps(entry: ReliefEntryLike, view: ReliefView): boolean {
  if (entry.queueId !== "takes") return true;
  const id = takeIdOf(entry);
  if (Number.isFinite(id) && view.snoozed.has(id)) return false;
  if (entry.sourceId && view.muted.has(entry.sourceId)) return false;
  return Number.isFinite(id) && view.pileIds.has(id);
}

/** A take entry the relief view hides (snoozed or muted-source). */
export function reliefHidden(entry: ReliefEntryLike, view: ReliefView): boolean {
  if (entry.queueId !== "takes") return false;
  const id = takeIdOf(entry);
  return (
    (Number.isFinite(id) && view.snoozed.has(id)) ||
    (entry.sourceId !== null && entry.sourceId !== undefined && view.muted.has(entry.sourceId))
  );
}

/** The pile's display count (displayCounts.takes): pile minus muted minus snoozed. */
export function reliefPileCount(items: TakeProposal[], view: ReliefView): number {
  return items.filter((it) =>
    reliefKeeps(
      {
        queueId: "takes",
        sourceId: it.source_id ?? "default",
        item: it,
      },
      view,
    ),
  ).length;
}

/** The quiet numbers line's buckets (disjoint: every pending row lands in one). */
export function reliefCounts(
  items: TakeProposal[],
  view: ReliefView,
): { pile: number; snoozed: number; muted: number; backlog: number } {
  let pile = 0;
  let snoozed = 0;
  let muted = 0;
  for (const it of items) {
    const source = it.source_id ?? "default";
    if (view.muted.has(source)) muted++;
    else if (view.snoozed.has(it.id)) snoozed++;
    else if (view.pileIds.has(it.id)) pile++;
  }
  return { pile, snoozed, muted, backlog: items.length - pile - snoozed - muted };
}

/**
 * The batch gate over the relief view (0.5.2 hard line): a page holding a
 * HIDDEN entry (snoozed or muted take) hides the batch-reject button — the
 * all-view must never terminally kill entries the user deliberately shelved.
 */
export function batchablePageRelief(
  entries: Array<ReliefEntryLike>,
  view: ReliefView | null,
): boolean {
  if (!view) return batchablePage(entries as Array<{ queueId: QueueId }>);
  return (
    batchablePage(entries as Array<{ queueId: QueueId }>) &&
    entries.every((e) => !reliefHidden(e, view))
  );
}
