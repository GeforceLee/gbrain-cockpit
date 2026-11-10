import type { ContradictionProposal, TrustReviewItem } from "@gbrain-cockpit/shared";

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
