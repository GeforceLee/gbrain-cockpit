import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  ADJUDICATION_CHANNELS,
  TRUST_REF_RE,
  contradictionAcceptCommand,
  contradictionRejectCommand,
  edgeAcceptCommand,
  trustConfirmCommand,
  trustDropCommand,
  trustExplainCommand,
  trustReleaseCommand,
} from "@gbrain-cockpit/shared";
import type {
  AdjudicationAction,
  ContradictionProposal,
  EdgeProposal,
  ExtractionStub,
  InboxReport,
  TakeItem,
  TakeProposal,
  TakeQuality,
  TakeQueueCommands,
  TrustReviewItem,
} from "@gbrain-cockpit/shared";
import { AuditBlock } from "../components/AuditBlock";
import { ChannelMatrixCard, type ChannelRow } from "../components/ChannelMatrixCard";
import { CopyCommand } from "../components/CopyCommand";
import { PageDrawer } from "../components/PageDrawer";
import { Pager, usePageSize } from "../components/Pager";
import { StampButton } from "../components/StampButton";
import { Tag, type TagVariant } from "../components/Tag";
import { TrustChain } from "../components/TrustChain";
import { VerdictHistory } from "../components/VerdictHistory";
import { appendAudit, type AuditMeta } from "../lib/auditLog";
import { copyCommandText } from "../lib/clipboard";
import { ApiError, apiGet, apiSend } from "../lib/api";
import { errorMessage } from "../lib/errors";
import { currentProfile } from "../lib/brain";
import { useI18n, type MessageKey } from "../lib/i18n";
import { isSlugLike, useSlugSiblings, type PageRef } from "../lib/pages";
import { firstLine } from "../lib/text";

// Inbox — the adjudication desk, in the frozen v5 interaction model:
// queue tabs | queue-card list | document + decision rail, with the stamp
// drop as the brand moment and the ink audit block as the fixed receipt
// slot. The action trichotomy is STRUCTURAL (style-review hard constraint):
// one-key actions are stamp buttons, terminal-confirmation actions are
// ALWAYS copy-command blocks (owner-presence, gbrain ENG-15 — never batched,
// never a button), and when the CLI channel is unavailable on this host,
// CLI one-key actions degrade to copy-command blocks too.

type QueueId =
  | "proposals"
  | "held"
  | "facts"
  | "edges"
  | "takes"
  | "contradictions"
  | "extraction"
  | "judgments"
  | "others";
type TabId = "all" | Exclude<QueueId, "others">;

/** keep-alive refresh threshold: re-fetch the queues once when returning to
 *  the desk after this long away (queue verdicts elsewhere change counts) */
const INBOX_STALE_MS = 60_000;

// Queue cards are paginated (the takes queue alone can hold 500+ items per
// dream run); the page size is user-selectable and persists per browser.

interface Entry {
  key: string;
  queueId: QueueId;
  /** corner badge text (mono) */
  ref: string;
  /** badge emphasis: held writes amber, terminal refs red */
  refClass: "" | "held" | "term";
  title: string;
  sub?: string;
  /** TARGET block in the document head (page slug / edge endpoint) */
  target?: string;
  /** the item's source, when it carries one (takes do; 0.60.558 trust/edge
   *  items don't — read defensively, absent means "not grouped") */
  sourceId?: string;
  tags: { variant: TagVariant; text: string }[];
  srcLines: string[];
  item: TrustReviewItem | EdgeProposal | TakeProposal;
}

interface StampState {
  variant: "drop" | "ok";
  zh: string;
  en: string;
}

/** gbrain review items carry their exact commands when available — prefer them. */
function itemCommand(item: TrustReviewItem, match: string[]): string | null {
  const c = item.commands;
  const candidates: string[] = [];
  if (Array.isArray(c)) {
    candidates.push(...c.filter((x): x is string => typeof x === "string"));
  } else if (c && typeof c === "object") {
    candidates.push(
      ...Object.values(c).filter((x): x is string => typeof x === "string"),
    );
  }
  return (
    candidates.find((cmd) => match.some((m) => cmd.includes(m))) ?? null
  );
}

function itemSummary(item: TrustReviewItem): string {
  for (const key of ["summary", "title", "reason", "claim", "detail"]) {
    const v = item[key];
    if (typeof v === "string" && v.trim()) return v.slice(0, 300);
  }
  return "";
}

function stringField(item: object, key: string): string | undefined {
  const v = (item as Record<string, unknown>)[key];
  return typeof v === "string" && v.trim() ? v : undefined;
}

// --- owner-terminal command safety -------------------------------------------
// Copy-command blocks are pasted into the owner's shell, so every value we
// interpolate is defense-in-depth validated client-side too (the server's
// drop route applies the same pattern). A malformed ref from a buggy or
// hostile gbrain must never become shell text.

/** trust refs only, by the shared pattern (same as the server route). */
function safeRef(ref: string | undefined): string {
  return ref && TRUST_REF_RE.test(ref) ? ref : "?";
}

/** the "see on the graph" affordance — rendered wherever a document card has
 *  a resolvable target (the cross-panel reverse edge into Nebula). */
function GraphJumpButton({
  entry,
  onGraph,
  t,
}: {
  entry: Entry;
  onGraph?: (ref: PageRef) => void;
  t: (k: MessageKey) => string;
}) {
  const src = stringField(entry.item, "source_id");
  if (!onGraph || !isSlugLike(entry.target)) return null;
  return (
    <button
      type="button"
      className="linkish small"
      onClick={() =>
        onGraph({ slug: entry.target!, ...(src ? { sourceId: src } : {}) })
      }
    >
      {t("pages.inGraph")}
    </button>
  );
}

/** numeric ids only (edge-proposal / take ids). */
function safeId(id: string | undefined): string {
  return id && /^\d{1,18}$/.test(id) ? id : "?";
}

/**
 * Server-built take copy-commands are our own API's output, but they are
 * still pasted into the owner's shell — so they pass the same metachar-free
 * gate as gbrain's own command text before reaching a copy block (anything
 * odd degrades to the explainer note, never a paste).
 */
const TAKE_CMD_RE = /^[A-Za-z0-9 =_./-]{1,300}$/;

/**
 * Gate gbrain's own command text before it reaches a copy block: it must be
 * an invocation of THIS brain's command (the profile's bin — on a wrapper
 * brain like `gbrain-bip`, upstream's literal `gbrain …` text would run
 * against the DEFAULT brain: a wrong-brain mutation, so it must fall back)
 * and free of shell metacharacters. The fallback is always the command
 * cockpit builds from validated parts. Do NOT "fix" this back to a bare
 * `gbrain ` prefix — that reintroduces the wrong-brain paste.
 */
function ownerSafeCommand(
  cmd: string | null,
  fallback: string,
  bin: string,
): string {
  if (
    cmd !== null &&
    cmd.startsWith(`${bin} `) &&
    !/[;&|><$`"'\n]/.test(cmd)
  ) {
    return cmd;
  }
  return fallback;
}

export function Inbox({
  active,
  onOpenPage,
  onOpenGraph,
  onTotal,
}: {
  /** keep-alive: true while this panel is the visible one */
  active?: boolean;
  onOpenPage?: (ref: PageRef) => void;
  /** "see on the graph" — the cross-panel reverse edge */
  onOpenGraph?: (ref: PageRef) => void;
  /** sidebar count chip — reported after every fetch, no extra request */
  onTotal?: (total: number) => void;
}) {
  const { t, locale } = useI18n();
  const [report, setReport] = useState<InboxReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [tab, setTab] = useState<TabId>("all");
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = usePageSize("cockpit.pagesize.inbox");
  const [detail, setDetail] = useState<Entry | null>(null);
  const [stamp, setStamp] = useState<StampState | null>(null);
  // two-step confirm for the page-level batch reject (takes, CLI channel)
  const [batchArmed, setBatchArmed] = useState(false);
  const [batchBusy, setBatchBusy] = useState(false);
  // page reference opened in the shared in-place drawer (never a panel jump)
  const [peek, setPeek] = useState<PageRef | null>(null);
  const slugSiblings = useSlugSiblings(peek?.slug ?? null, peek?.sourceId);
  // keep-alive staleness: when the panel comes back into view older than
  // this, one silent refresh re-syncs the queue (dream runs and verdicts
  // from other surfaces change it while the desk is hidden)
  const fetchedAtRef = useRef(0);

  const refresh = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      setReport(await apiGet<InboxReport>("/api/inbox"));
      fetchedAtRef.current = Date.now();
    } catch (err) {
      setReport(null);
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (
      active &&
      fetchedAtRef.current > 0 &&
      Date.now() - fetchedAtRef.current > INBOX_STALE_MS
    ) {
      void refresh();
    }
  }, [active, refresh]);

  const cliAvailable = report?.cliChannel.available === true;
  // The profile's owner command name — wrapper brains (gbrain-bip) print
  // THEIR name in every copy-command; "gbrain" when unset.
  const cliCommand = report?.cliChannel.command ?? "gbrain";
  const canConfirm = currentProfile()?.canConfirm;
  const trustItems = report?.trust.items ?? [];
  const proposals = trustItems.filter((i) => (i.ref ?? "").startsWith("tp"));
  const heldWrites = trustItems.filter((i) => (i.ref ?? "").startsWith("h"));
  const facts = trustItems.filter((i) => (i.ref ?? "").startsWith("f"));
  // dp<id> entries are decide-proposal contradictions: they surface in the
  // trust queue's data but their disposition verbs are the decide family —
  // so they ride the contradictions queue, never trust drop/confirm.
  const dpTrustItems = trustItems.filter((i) => (i.ref ?? "").startsWith("dp"));
  const others = trustItems.filter((i) => {
    const r = i.ref ?? "";
    return (
      r &&
      !r.startsWith("tp") &&
      !r.startsWith("h") &&
      !r.startsWith("f") &&
      !r.startsWith("dp")
    );
  });
  const edges = report?.edgeProposals.items ?? [];
  const takes = report?.takes.items ?? [];
  const decideProposals = report?.contradictions.items ?? [];
  const extractionStubs = report?.extraction.items ?? [];
  const activeTakes = report?.activeTakes.items ?? [];

  const queueCounts: Record<QueueId, number> = {
    proposals: proposals.length,
    held: heldWrites.length,
    facts: facts.length,
    edges: edges.length,
    takes: takes.length,
    contradictions: dpTrustItems.length + decideProposals.length,
    extraction: extractionStubs.length,
    judgments: activeTakes.filter((x) => !x.resolved_outcome).length,
    others: others.length,
  };

  // Channel down ≠ queue empty (e.g. gbrain thin-client hosts cannot run the
  // trust CLI family): surface unavailability per queue instead of "empty".
  // The trust queue backs proposals/held/facts/others; edges and takes have
  // their own channels.
  const trustDown =
    report && report.trust.status !== "ok" ? firstLine(report.trust.error) : null;
  const queueDown: Partial<Record<QueueId, string>> = {
    ...(trustDown
      ? { proposals: trustDown, held: trustDown, facts: trustDown, others: trustDown }
      : {}),
    ...(report && report.edgeProposals.status !== "ok"
      ? { edges: firstLine(report.edgeProposals.error) }
      : {}),
    ...(report && report.takes.status !== "ok"
      ? { takes: firstLine(report.takes.error) }
      : {}),
    ...(report && report.contradictions.status !== "ok"
      ? { contradictions: firstLine(report.contradictions.error) }
      : {}),
    ...(report && report.extraction.status !== "ok"
      ? { extraction: firstLine(report.extraction.error) }
      : {}),
    ...(report && report.activeTakes.status !== "ok"
      ? { judgments: firstLine(report.activeTakes.error) }
      : {}),
  };
  const downNotices = (tabId: TabId): string[] =>
    tabId === "all"
      ? ([...new Set(Object.values(queueDown).filter(Boolean))] as string[])
      : queueDown[tabId] !== undefined
        ? [queueDown[tabId]!]
        : [];

  useEffect(() => {
    if (!report) return;
    onTotal?.(
      queueCounts.proposals +
        queueCounts.held +
        queueCounts.facts +
        queueCounts.edges +
        queueCounts.takes +
        queueCounts.contradictions +
        queueCounts.others,
    );
  }, [report]); // onTotal is a stable state setter from the shell

  // --- entry assembly --------------------------------------------------------

  function trustEntry(
    queueId: "proposals" | "held" | "facts" | "contradictions" | "others",
    item: TrustReviewItem,
  ): Entry {
    const ref = item.ref ?? "?";
    return {
      key: `trust-${ref}`,
      queueId,
      ref,
      refClass: queueId === "held" ? "held" : queueId === "facts" ? "term" : "",
      title: itemSummary(item) || ref,
      sub: stringField(item, "kind"),
      target:
        stringField(item, "target") ??
        stringField(item, "page") ??
        stringField(item, "page_slug") ??
        stringField(item, "path"),
      ...(stringField(item, "source_id")
        ? { sourceId: stringField(item, "source_id") }
        : {}),
      tags: [
        { variant: "soft", text: t(`inbox.queue.${queueId}` as MessageKey) },
        ...(stringField(item, "kind")
          ? [{ variant: "plain" as TagVariant, text: stringField(item, "kind")! }]
          : []),
      ],
      srcLines: [
        stringField(item, "source") ?? stringField(item, "origin") ?? "",
      ].filter(Boolean),
      item,
    };
  }

  function edgeEntry(p: EdgeProposal): Entry {
    const id = String(p.id ?? "");
    const from = stringField(p, "from_slug") ?? stringField(p, "from") ?? "?";
    const to = stringField(p, "to_slug") ?? stringField(p, "to") ?? "?";
    const rel = stringField(p, "link_type") ?? stringField(p, "relation") ?? "";
    return {
      key: `edge-${id}`,
      queueId: "edges",
      ref: id ? `#${id}` : "edge",
      refClass: "",
      title: `${from} → ${to}`,
      sub: rel,
      target: to,
      ...(stringField(p, "source_id") ? { sourceId: stringField(p, "source_id") } : {}),
      tags: [
        { variant: "soft", text: t("inbox.queue.edges") },
        ...(rel ? [{ variant: "plain" as TagVariant, text: rel }] : []),
      ],
      srcLines: [from, to].filter(Boolean),
      item: p,
    };
  }

  function takeEntry(take: TakeProposal): Entry {
    return {
      key: `take-${take.id}`,
      queueId: "takes",
      ref: `#${take.id}`,
      refClass: "",
      title: take.claim_text,
      sub: take.kind,
      target: take.page_slug,
      ...(take.source_id ? { sourceId: take.source_id } : {}),
      tags: [
        { variant: "soft", text: t("inbox.queue.takes") },
        ...(take.kind ? [{ variant: "plain" as TagVariant, text: take.kind }] : []),
        ...(take.holder ? [{ variant: "warn" as TagVariant, text: take.holder }] : []),
      ],
      srcLines: [take.page_slug, take.model_id ?? ""].filter(Boolean),
      item: take,
    };
  }

  /** decide-family contradiction proposal (row shape probed empty on 0.60.611
   *  — every field except id is defensive: render what looks known, never
   *  assume). The dp<id> trust-review twins of these rows render via
   *  trustEntry("contradictions", …) with the same rail. */
  function contradictionEntry(p: ContradictionProposal): Entry {
    const id = String(p.id ?? "");
    const sev =
      stringField(p, "severity") ?? stringField(p, "kind") ?? undefined;
    const target =
      stringField(p, "page_slug") ??
      stringField(p, "slug") ??
      stringField(p, "left_slug") ??
      stringField(p, "slug_a") ??
      stringField(p, "target");
    return {
      key: `contradiction-${id || JSON.stringify(p).slice(0, 40)}`,
      queueId: "contradictions",
      ref: id ? `#${id}` : "dp",
      refClass: "",
      title: itemSummary(p as TrustReviewItem) || `#${id}`,
      sub: sev,
      target,
      ...(stringField(p, "source_id")
        ? { sourceId: stringField(p, "source_id") }
        : {}),
      tags: [
        { variant: "soft", text: t("inbox.queue.contradictions") },
        ...(sev ? [{ variant: "warn" as TagVariant, text: sev }] : []),
      ],
      srcLines: [target ?? ""].filter(Boolean),
      item: p,
    };
  }

  /** entity-stub entry (read-only lane — shapes are defensive until a real
   *  brain carries stubs; the fields below are upstream's documented ones) */
  function extractionEntry(stub: ExtractionStub): Entry {
    const slug =
      stringField(stub, "slug") ?? stringField(stub, "page_slug") ?? "?";
    const name =
      stringField(stub, "name") ?? stringField(stub, "title") ?? slug;
    return {
      key: `stub-${slug}-${name}`,
      queueId: "extraction",
      ref: "•",
      refClass: "",
      title: name,
      sub: stringField(stub, "type") ?? stringField(stub, "kind"),
      target: slug,
      ...(stringField(stub, "source_id")
        ? { sourceId: stringField(stub, "source_id") }
        : {}),
      tags: [{ variant: "soft", text: t("inbox.queue.extraction") }],
      srcLines: [slug].filter(Boolean),
      item: stub,
    };
  }

  /** ACTIVE take awaiting judgment — the propose→accept→witness→resolve loop. */
  function judgmentEntry(take: TakeItem): Entry {
    const slug = take.ref ?? stringField(take, "page_slug") ?? "?";
    const row = typeof take.row_num === "number" ? take.row_num : undefined;
    const id = typeof take.id === "number" ? take.id : row;
    return {
      key: `judge-${slug}-${row ?? id ?? take.claim?.slice(0, 24)}`,
      queueId: "judgments",
      ref: row !== undefined ? `r${row}` : id !== undefined ? `#${id}` : "take",
      refClass: "",
      title: take.claim ?? slug,
      sub: take.kind,
      target: stringField(take, "page_slug") ?? slug,
      ...(stringField(take, "source_id")
        ? { sourceId: stringField(take, "source_id") }
        : {}),
      tags: [
        { variant: "soft", text: t("inbox.queue.judgments") },
        ...(take.holder
          ? [{ variant: "warn" as TagVariant, text: take.holder }]
          : []),
        ...(take.resolved_outcome
          ? [{ variant: "plain" as TagVariant, text: String(take.resolved_outcome) }]
          : []),
      ],
      srcLines: [
        stringField(take, "page_slug") ?? slug,
        stringField(take, "since_date") ?? "",
      ].filter(Boolean),
      item: take,
    };
  }

  const allEntries: Entry[] = [
    ...proposals.map((i) => trustEntry("proposals", i)),
    ...heldWrites.map((i) => trustEntry("held", i)),
    ...facts.map((i) => trustEntry("facts", i)),
    ...edges.map(edgeEntry),
    ...takes.map(takeEntry),
    ...dpTrustItems.map((i) => trustEntry("contradictions", i)),
    ...decideProposals.map(contradictionEntry),
    ...extractionStubs.map(extractionEntry),
    ...activeTakes.map(judgmentEntry),
    ...others.map((i) => trustEntry("others", i)),
  ];
  /** inbox source filter: null = all sources (observed ids are the options —
   *  the inbox groups by what its items actually carry, not the page axis) */
  const [sourceFilter, setSourceFilter] = useState<string | null>(null);
  const observedSources = new Set(
    allEntries.flatMap((e) => (e.sourceId ? [e.sourceId] : [])),
  );
  const entriesWithSource = allEntries.filter(
    (e) => sourceFilter === null || e.sourceId === sourceFilter,
  );
  const visibleEntries =
    tab === "all"
      ? entriesWithSource
      : entriesWithSource.filter((e) => e.queueId === tab);

  /**
   * Takes group by source (upstream: proposals are per-source rows; dream
   * runs per source). A head line renders before each source's first take
   * on the current page — when several sources share the page.
   */
  function groupHeads(pageEntries: Entry[]): ReactNode[] {
    const out: ReactNode[] = [];
    let lastSource: string | null | undefined;
    let multiOnPage = false;
    const seen = new Set<string>();
    for (const e of pageEntries) {
      if (e.queueId !== "takes") continue;
      if (e.sourceId) {
        seen.add(e.sourceId);
        if (seen.size > 1) multiOnPage = true;
      }
    }
    if (!multiOnPage) return out;
    for (const e of pageEntries) {
      if (e.queueId !== "takes" || !e.sourceId) continue;
      if (e.sourceId === lastSource) continue;
      lastSource = e.sourceId;
      const n = pageEntries.filter(
        (x) => x.queueId === "takes" && x.sourceId === e.sourceId,
      ).length;
      out.push(
        <p key={`src-head-${e.sourceId}`} className="src-group-head">
          <span className="src-chip mono">{e.sourceId}</span>
          <span>{t("inbox.group.source").replace("{name}", e.sourceId).replace("{n}", String(n))}</span>
        </p>,
      );
    }
    return out;
  }

  const totalPages = Math.max(1, Math.ceil(visibleEntries.length / pageSize));
  const safePage = Math.min(page, totalPages - 1);
  const pagedEntries = visibleEntries.slice(
    safePage * pageSize,
    (safePage + 1) * pageSize,
  );
  // tab switches and refreshed-shorter lists fall back to the last page
  useEffect(() => {
    setPage((p) => Math.min(p, totalPages - 1));
  }, [totalPages, tab]);

  // --- actions ----------------------------------------------------------------

  async function act(
    path: string,
    body: unknown,
    auditText: string,
    stampState?: StampState,
    meta?: AuditMeta,
  ): Promise<boolean> {
    setActionError(null);
    try {
      await apiSend(path, "POST", body);
      appendAudit(`${auditText} -> OK`, meta);
      // cross-panel freshness: Nebula's pending overlay listens for this
      window.dispatchEvent(new CustomEvent("cockpit:verdict"));
      if (stampState) setStamp(stampState);
      await refresh();
      // pipeline feel: after a stamped verdict the desk advances to the NEXT
      // item on its own — the stamp stays visible on the fresh selection
      if (stampState && detail) {
        const idx = visibleEntries.findIndex((e) => e.key === detail.key);
        const next = idx >= 0 ? visibleEntries[idx + 1] : undefined;
        if (next) setDetail(next); // NOT select(): the stamp must survive
      }
      return true;
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : String(err);
      appendAudit(`${auditText} -> ERR ${firstLine(msg)}`);
      setActionError(msg);
      return false;
    }
  }

  // j/k walk the visible queue (the terminal mail-client feel; inert while
  // typing, like the ⌘⌫/⌘↵ affordances in the rail)
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "j" && e.key !== "k") return;
      const target = e.target as HTMLElement | null;
      const typing =
        target !== null &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable);
      if (typing || visibleEntries.length === 0) return;
      e.preventDefault();
      const idx = detail ? visibleEntries.findIndex((e) => e.key === detail.key) : -1;
      const next =
        e.key === "j"
          ? visibleEntries[Math.min(idx + 1, visibleEntries.length - 1)]!
          : visibleEntries[Math.max(idx - 1, 0)]!;
      select(next);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  function select(entry: Entry) {
    setDetail(entry);
    setStamp(null);
  }

  // Page-level batch reject (takes/edges tabs, CLI one-key channel ONLY —
  // terminal-confirmation actions are never batched, style-review hard
  // constraint). Sequential sends with per-item audit lines; stops at the
  // first failure so the audit trail always tells the truth about how far it
  // got.
  async function batchRejectPage(items: Entry[]) {
    if (batchBusy) return;
    setBatchBusy(true);
    setBatchArmed(false);
    setActionError(null);
    let done = 0;
    for (const entry of items) {
      const isTake = entry.queueId === "takes";
      const take = entry.item as TakeProposal;
      const edgeId = String((entry.item as EdgeProposal).id ?? "");
      const auditRef = isTake ? String(take.id) : edgeId;
      const auditLabel = (
        isTake ? take.claim_text : entry.title
      ).slice(0, 80);
      try {
        await apiSend(
          isTake ? "/api/inbox/takes/propose" : "/api/inbox/edge",
          "POST",
          isTake
            ? { op: "reject", id: String(take.id) }
            : { op: "reject", id: edgeId },
        );
        appendAudit(`${isTake ? "takes.propose" : "edge"}.reject ${auditRef} -> OK`, {
          ref: auditRef,
          label: auditLabel,
          verdict: "stop",
          verdictText: t("verdict.rejected"),
        });
        done++;
      } catch (err) {
        const msg = err instanceof ApiError ? err.message : String(err);
        appendAudit(`${isTake ? "takes.propose" : "edge"}.reject ${auditRef} -> ERR ${firstLine(msg)}`);
        setActionError(msg);
        break;
      }
    }
    setBatchBusy(false);
    if (done > 0) {
      window.dispatchEvent(new CustomEvent("cockpit:verdict"));
      await refresh();
    }
  }

  const tabs: { id: TabId; label: string; n: number }[] = [
    { id: "all", label: t("inbox.tab.all"), n: allEntries.length },
    { id: "proposals", label: t("inbox.queue.proposals"), n: queueCounts.proposals },
    { id: "held", label: t("inbox.queue.held"), n: queueCounts.held },
    { id: "facts", label: t("inbox.queue.facts"), n: queueCounts.facts },
    { id: "edges", label: t("inbox.queue.edges"), n: queueCounts.edges },
    { id: "takes", label: t("inbox.queue.takes"), n: queueCounts.takes },
    {
      id: "contradictions",
      label: t("inbox.queue.contradictions"),
      n: queueCounts.contradictions,
    },
    {
      id: "extraction",
      label: t("inbox.queue.extraction"),
      n: queueCounts.extraction,
    },
    { id: "judgments", label: t("inbox.queue.judgments"), n: queueCounts.judgments },
  ];

  return (
    <section className="panel inbox">
      {/* FIRST child on purpose: the drawer's sticky anchor pins to the
          stage viewport from its natural position — at the panel top it is
          on screen the instant the drawer opens; as the LAST child it would
          render ~2000px below the fold and "nothing would happen" */}
      <PageDrawer
        page={peek}
        onClose={() => setPeek(null)}
        onEdit={onOpenPage}
        siblings={slugSiblings.map((x) => ({ slug: peek!.slug, sourceId: x.source_id }))}
        onOpenSibling={(ref) => setPeek(ref)}
      />
      <nav className="tabs" aria-label={t("panel.inbox.title")}>
        {tabs.map((tb) => (
          <button
            key={tb.id}
            type="button"
            className={`tab ${tab === tb.id ? "on" : ""}`}
            aria-pressed={tab === tb.id}
            onClick={() => {
              setTab(tb.id);
              setPage(0);
              setBatchArmed(false);
            }}
          >
            {tb.label}{" "}
            <span className="n">
              {tb.id !== "all" && queueDown[tb.id] !== undefined ? "?" : tb.n}
            </span>
          </button>
        ))}
      </nav>

      <div className="inbox-meta">
        <div className="list-tools">
          <span
            className={`chip ${cliAvailable ? "chip-ok" : "chip-degraded"}`}
            title={
              cliAvailable
                ? t("inbox.cliCold")
                : report?.cliChannel.error
                  ? firstLine(report.cliChannel.error)
                  : undefined
            }
          >
            {cliAvailable
              ? t("inbox.cliOk")
              : // "binary-not-found" keeps the conditional host guess; every
                // other unavailable state (found but probe unverified — or a
                // pre-reason payload) gets the neutral copy: the probe
                // failed, the Health panel has the details.
                report?.cliChannel.reason === "binary-not-found"
                ? t("inbox.cliMissing")
                : t("inbox.cliUnverified")}
          </span>
          <button type="button" onClick={() => void refresh()} disabled={busy}>
            {busy ? t("common.loading") : t("health.refresh")}
          </button>
        </div>
      </div>

      {error && (
        <p className="error inbox-error">
          {t("common.errorLabel")}: {errorMessage(error, t)}
        </p>
      )}
      {actionError && (
        <p className="error inbox-error" role="alert">
          {t("common.errorLabel")}: {errorMessage(actionError, t)}
        </p>
      )}
      {!report && !error && <p className="muted inbox-error">{t("common.loading")}</p>}

      {report && (
        <div className="split">
          <div className="list">
            <div className="list-tools">
              <span className="muted">
                {t("inbox.listCaption")} · {visibleEntries.length}
              </span>
              {observedSources.size > 0 ? (
                <select
                  className="source-filter"
                  value={sourceFilter ?? ""}
                  onChange={(e) => setSourceFilter(e.target.value || null)}
                  aria-label={t("inbox.filter.source")}
                  title={t("inbox.filter.source")}
                >
                  <option value="">{t("pages.allSources")}</option>
                  {[...observedSources].map((id) => (
                    <option key={id} value={id}>
                      {id}
                    </option>
                  ))}
                </select>
              ) : null}
              {(tab === "takes" || tab === "edges") &&
                cliAvailable &&
                pagedEntries.length > 0 && (
                <button
                  type="button"
                  className={batchArmed ? "batch-arm" : ""}
                  disabled={batchBusy}
                  title={t("inbox.cliCold")}
                  onClick={() => {
                    if (batchArmed) {
                      void batchRejectPage(pagedEntries);
                      return;
                    }
                    setBatchArmed(true);
                    setTimeout(() => setBatchArmed(false), 4000);
                  }}
                >
                  {batchBusy
                    ? t("common.loading")
                    : batchArmed
                      ? `${t("inbox.batch.confirm")} · ${pagedEntries.length}`
                      : `${t("inbox.batch.reject")} · ${pagedEntries.length}`}
                </button>
              )}
              {totalPages > 1 && (
                <Pager
                  page={safePage}
                  totalPages={totalPages}
                  size={pageSize}
                  onPage={setPage}
                  onSize={(next) => {
                    setPageSize(next);
                    setPage(0);
                  }}
                />
              )}
            </div>
            {downNotices(tab).map((err, i) => (
              <p key={i} className="muted empty-note">
                {t("inbox.queueUnavailable")}: {err}
              </p>
            ))}
            {tab !== "all" && (
              // the selected queue's one-line self-description (AGENTS.md:
              // every surface carries its own explanation)
              <p className="muted empty-note">
                {t(`inbox.queue.${tab}Desc` as MessageKey)}
              </p>
            )}
            {tab === "contradictions" && <ContradictionProbeNote report={report} />}
            {tab === "takes" &&
              report?.takes.failed?.status === "ok" &&
              (report.takes.failed.items?.length ?? 0) > 0 && (
                <p className="muted empty-note">
                  {t("inbox.failedNote").replace(
                    "{n}",
                    String(report.takes.failed.items!.length),
                  )}
                </p>
              )}
            {tab === "extraction" && report && (
              <p className="muted empty-note">
                {t("inbox.extraction.unattributed")}:{" "}
                {report.extraction.unattributedCount ?? 0} ·{" "}
                {t("inbox.extraction.duplicates")}:{" "}
                {report.extraction.duplicatesCount ?? 0}
              </p>
            )}
            {visibleEntries.length === 0 && downNotices(tab).length === 0 && (
              <p className="muted empty-note">{t("inbox.empty")}</p>
            )}
            {(tab === "takes" || tab === "all") &&
              observedSources.size > 1 &&
              sourceFilter === null &&
              groupHeads(pagedEntries).map((head) => head)}
            {pagedEntries.map((entry) => (
              <button
                key={entry.key}
                type="button"
                className={`qcard ${detail?.key === entry.key ? "sel" : ""}`}
                onClick={() => select(entry)}
              >
                <span className={`ref ${entry.refClass}`}>{entry.ref}</span>
                <span className="head">
                  <span>
                    <span className="title">{entry.title}</span>
                    {entry.sub ? <span className="sub">{entry.sub}</span> : null}
                  </span>
                  {entry.queueId === "takes" || entry.queueId === "edges" ? (
                    <span className="metric">
                      <span className="v">{entry.ref.replace("#", "")}</span>
                      <span className="u">id</span>
                    </span>
                  ) : null}
                </span>
                {entry.tags.length > 0 && (
                  <span className="tags">
                    {entry.tags.map((tg, i) => (
                      <Tag key={i} variant={tg.variant}>
                        {tg.text}
                      </Tag>
                    ))}
                  </span>
                )}
                <span className="foot">
                  <span className="src">{entry.srcLines.join("\n")}</span>
                  {/* 采集→抽取→拦截→owner→生效: trust-family items sit at the
                      owner stage — that is the whole reason this desk exists */}
                  {entry.queueId !== "edges" && entry.queueId !== "takes" ? (
                    <TrustChain stages={5} active={3} />
                  ) : null}
                </span>
              </button>
            ))}
          </div>

          <div className="detail grid-paper">
            {detail ? (
              <>
                <div className="doc-layout">
                  <div className={`document ${stamp ? "shake" : ""}`}>
                    <DocumentCard entry={detail} onPeek={setPeek} onGraph={onOpenGraph} />
                    {stamp ? (
                      <div className={`big-stamp ${stamp.variant}`}>
                        <span className="zh">{stamp.zh}</span>
                        {locale === "zh-CN" ? (
                          <span className="en">{stamp.en}</span>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                  <DecisionRail
                    entry={detail}
                    cliAvailable={cliAvailable}
                    cliCommand={cliCommand}
                    canConfirm={canConfirm}
                    act={act}
                    takeCommands={report.takes.commands}
                  />
                </div>
                <AuditBlock />
                <VerdictHistory />
              </>
            ) : (
              <div className="doc-layout">
                <div className="document">
                  <p className="doc-body muted">{t("inbox.noSelection")}</p>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

// --- contradiction probe header ------------------------------------------------

/** The eval probe's last-run state — the lane's informational header. All
 *  states self-describe: "never ran" never masquerades as "no contradictions"
 *  (upstream's own note told us so), "ran" says when and how much it saw. */
function ContradictionProbeNote({ report }: { report: InboxReport }) {
  const { t } = useI18n();
  const probe = report.contradictions.probe;
  if (!probe) {
    return (
      <p className="muted empty-note">{t("inbox.contradiction.probeUnavailable")}</p>
    );
  }
  if (probe.note) {
    return (
      <p className="muted empty-note">{t("inbox.contradiction.probeNever")}</p>
    );
  }
  const at = probe.ranAt ? probe.ranAt.replace("T", " ").slice(0, 16) : "?";
  return (
    <p className="muted empty-note">
      {t("inbox.contradiction.probeRan")
        .replace("{at}", at)
        .replace("{n}", String(probe.totalVisible ?? 0))}
    </p>
  );
}

// --- document card -------------------------------------------------------------

function DocumentCard({
  entry,
  onPeek,
  onGraph,
}: {
  entry: Entry;
  /** open a page reference in the shared in-place drawer (never a jump) */
  onPeek?: (ref: PageRef) => void;
  /** "see on the graph" — the cross-panel reverse edge */
  onGraph?: (ref: PageRef) => void;
}) {
  const { t } = useI18n();
  const item = entry.item;

  if (entry.queueId === "edges") {
    // human-readable first, raw as the fallback record (支柱二: the raw JSON
    // dump was the lane's readability hole; known-looking fields render
    // structured, everything else stays one fold away)
    const from = stringField(item, "from_slug") ?? stringField(item, "from") ?? "?";
    const to = stringField(item, "to_slug") ?? stringField(item, "to") ?? "?";
    const rel = stringField(item, "link_type") ?? stringField(item, "relation") ?? "—";
    const date = stringField(item, "since_date") ?? stringField(item, "date");
    const context = stringField(item, "context");
    return (
      <>
        <div className="doc-head">
          <div>
            <h2>{entry.title}</h2>
            <p className="refline mono">{entry.ref} · {t("inbox.queue.edges")}</p>
          </div>
          <div className="to">
            <div className="mono to-cap">{t("inbox.doc.target")}</div>
            {onPeek && isSlugLike(entry.target) ? (
              <button
                type="button"
                className="linkish to-link"
                onClick={() =>
                  onPeek({
                    slug: entry.target!,
                    ...(stringField(entry.item, "source_id")
                      ? { sourceId: stringField(entry.item, "source_id") }
                      : {}),
                  })
                }
              >
                {entry.target}
              </button>
            ) : (
              <b>{entry.target ?? "—"}</b>
            )}
            <GraphJumpButton entry={entry} onGraph={onGraph} t={t} />
          </div>
        </div>
        <div className="meta3">
          <div>
            <p className="k">from</p>
            <p className="v mono">{from}</p>
          </div>
          <div>
            <p className="k">to</p>
            <p className="v mono">{to}</p>
          </div>
          <div>
            <p className="k">{t("inbox.doc.kind")}</p>
            <p className="v">{rel}</p>
            {date ? <p className="s mono">{date}</p> : null}
          </div>
        </div>
        {context && (
          <>
            <p className="cap">{t("search.evidence")}</p>
            <p className="doc-body">{context.slice(0, 500)}</p>
          </>
        )}
        <details className="detail-block">
          <summary className="cap">{t("inbox.doc.raw")}</summary>
          <pre className="doc-raw">{JSON.stringify(item, null, 2)}</pre>
        </details>
      </>
    );
  }

  if (entry.queueId === "judgments") {
    const take = item as TakeItem;
    const row = typeof take.row_num === "number" ? take.row_num : undefined;
    const resolved = take.resolved_outcome;
    return (
      <>
        <div className="doc-head">
          <div>
            <h2>{take.claim ?? entry.title}</h2>
            <p className="refline mono">
              {entry.ref} · {t("inbox.queue.judgments")}
              {resolved ? ` · ${t("inbox.judge.resolved")}: ${String(resolved)}` : ""}
            </p>
          </div>
          <div className="to">
            <div className="mono to-cap">{t("inbox.doc.sourcePage")}</div>
            {onPeek && isSlugLike(entry.target) ? (
              <button
                type="button"
                className="linkish to-link"
                onClick={() =>
                  onPeek({
                    slug: entry.target!,
                    ...(stringField(item, "source_id")
                      ? { sourceId: stringField(item, "source_id") }
                      : {}),
                  })
                }
              >
                {entry.target}
              </button>
            ) : (
              <b>{entry.target ?? "—"}</b>
            )}
            <GraphJumpButton entry={entry} onGraph={onGraph} t={t} />
          </div>
        </div>
        <div className="meta3">
          <div>
            <p className="k">{t("inbox.doc.kind")}</p>
            <p className="v">{take.kind ?? "?"}</p>
          </div>
          <div>
            <p className="k">{t("inbox.doc.holder")}</p>
            <p className="v">{take.holder ?? "?"}</p>
          </div>
          <div>
            <p className="k">{t("inbox.doc.weightDomain")}</p>
            <p className="v">{typeof take.weight === "number" ? take.weight : "?"}</p>
            <p className="s">{stringField(item, "since_date") ?? "—"}</p>
          </div>
        </div>
      </>
    );
  }

  if (entry.queueId === "extraction") {
    const stub = item as ExtractionStub;
    return (
      <>
        <div className="doc-head">
          <div>
            <h2>{entry.title}</h2>
            <p className="refline mono">• {t("inbox.queue.extraction")}</p>
          </div>
          <div className="to">
            <div className="mono to-cap">{t("inbox.doc.target")}</div>
            {onPeek && isSlugLike(entry.target) ? (
              <button
                type="button"
                className="linkish to-link"
                onClick={() =>
                  onPeek({
                    slug: entry.target!,
                    ...(stringField(item, "source_id")
                      ? { sourceId: stringField(item, "source_id") }
                      : {}),
                  })
                }
              >
                {entry.target}
              </button>
            ) : (
              <b>{entry.target ?? "—"}</b>
            )}
            <GraphJumpButton entry={entry} onGraph={onGraph} t={t} />
          </div>
        </div>
        <div className="meta3">
          <div>
            <p className="k">{t("inbox.doc.kind")}</p>
            <p className="v">{entry.sub ?? "?"}</p>
          </div>
          <div>
            <p className="k">{t("inbox.extraction.unattributed")}</p>
            <p className="v">—</p>
          </div>
          <div>
            <p className="k">{t("inbox.extraction.duplicates")}</p>
            <p className="v">—</p>
          </div>
        </div>
        <p className="cap">{t("inbox.doc.raw")}</p>
        <pre className="doc-raw">{JSON.stringify(item, null, 2)}</pre>
      </>
    );
  }

  if (entry.queueId === "takes") {
    const take = item as TakeProposal;
    return (
      <>
        <div className="doc-head">
          <div>
            <h2>{take.claim_text}</h2>
            <p className="refline mono">take #{take.id} · {t("inbox.queue.takes")}</p>
          </div>
          <div className="to">
            <div className="mono to-cap">{t("inbox.doc.sourcePage")}</div>
            {onPeek ? (
              <button
                type="button"
                className="linkish to-link"
                onClick={() =>
                  onPeek({
                    slug: take.page_slug,
                    ...(take.source_id ? { sourceId: take.source_id } : {}),
                  })
                }
              >
                {take.page_slug}
              </button>
            ) : (
              <b>{take.page_slug}</b>
            )}
            <GraphJumpButton entry={entry} onGraph={onGraph} t={t} />
            <div className="mono to-cap">take #{take.id}</div>
          </div>
        </div>
        <div className="meta3">
          <div>
            <p className="k">{t("inbox.doc.kind")}</p>
            <p className="v">{take.kind ?? "?"}</p>
          </div>
          <div>
            <p className="k">{t("inbox.doc.holder")}</p>
            <p className="v">{take.holder ?? "?"}</p>
          </div>
          <div>
            <p className="k">{t("inbox.doc.weightDomain")}</p>
            <p className="v">{take.weight ?? "?"}</p>
            <p className="s">{take.domain ?? "?"}</p>
          </div>
        </div>
        {(take.model_id || take.proposed_at) && (
          <>
            <p className="cap">{t("inbox.doc.provenance")}</p>
            <p className="doc-body mono small">
              {[take.model_id, take.proposed_at].filter(Boolean).join(" · ")}
            </p>
          </>
        )}
      </>
    );
  }

  if (entry.queueId === "contradictions") {
    // decide rows carry numeric ids; their dp<id> trust-review twins carry a
    // ref — both render here, everything beyond that defensively (row shape
    // probed empty on 0.60.611, real fields land with the first real sweep)
    const p = item as ContradictionProposal;
    const ref =
      stringField(p, "ref") ?? (p.id !== undefined ? `#${String(p.id)}` : "—");
    const sev = stringField(p, "severity") ?? stringField(p, "kind");
    const created = stringField(p, "created_at");
    return (
      <>
        <div className="doc-head">
          <div>
            <h2>{entry.title}</h2>
            <p className="refline mono">
              {ref} · {t("inbox.queue.contradictions")}
            </p>
          </div>
          <div className="to">
            <div className="mono to-cap">{t("inbox.doc.target")}</div>
            {onPeek && isSlugLike(entry.target) ? (
              <button
                type="button"
                className="linkish to-link"
                onClick={() =>
                  onPeek({
                    slug: entry.target!,
                    ...(stringField(entry.item, "source_id")
                      ? { sourceId: stringField(entry.item, "source_id") }
                      : {}),
                  })
                }
              >
                {entry.target}
              </button>
            ) : (
              <b>{entry.target ?? t("inbox.doc.unknownTarget")}</b>
            )}
          </div>
        </div>
        <div className="meta3">
          <div>
            <p className="k">{t("inbox.doc.ref")}</p>
            <p className="v mono">{ref}</p>
          </div>
          <div>
            <p className="k">{t("inbox.contradiction.severity")}</p>
            <p className="v">{sev ?? "—"}</p>
          </div>
          <div>
            <p className="k">{t("pages.createdAt")}</p>
            <p className="v">{created ?? "—"}</p>
          </div>
        </div>
        <p className="cap">{t("inbox.doc.raw")}</p>
        <pre className="doc-raw">{JSON.stringify(item, null, 2)}</pre>
      </>
    );
  }

  // trust queues (proposals / held / facts / others)
  const trust = item as TrustReviewItem;
  const revision =
    stringField(trust, "expected_revision") ?? stringField(trust, "revision");
  return (
    <>
      <div className="doc-head">
        <div>
          <h2>{entry.title}</h2>
          <p className="refline mono">
            {trust.ref} · {t(`inbox.queue.${entry.queueId}` as MessageKey)}
          </p>
        </div>
        <div className="to">
          <div className="mono to-cap">{t("inbox.doc.target")}</div>
          {onPeek && isSlugLike(entry.target) ? (
            <button
              type="button"
              className="linkish to-link"
              onClick={() =>
                onPeek({
                  slug: entry.target!,
                  ...(stringField(entry.item, "source_id")
                    ? { sourceId: stringField(entry.item, "source_id") }
                    : {}),
                })
              }
            >
              {entry.target}
            </button>
          ) : (
            <b>{entry.target ?? t("inbox.doc.unknownTarget")}</b>
          )}
          <GraphJumpButton entry={entry} onGraph={onGraph} t={t} />
          {revision ? <div className="mono to-cap">rev {revision}</div> : null}
        </div>
      </div>
      <div className="meta3">
        <div>
          <p className="k">{t("inbox.doc.ref")}</p>
          <p className="v mono">{trust.ref ?? "?"}</p>
        </div>
        <div>
          <p className="k">{t("inbox.doc.kind")}</p>
          <p className="v">{stringField(trust, "kind") ?? "?"}</p>
        </div>
        <div>
          <p className="k">{t("inbox.doc.source")}</p>
          <p className="v">
            {stringField(trust, "source") ?? stringField(trust, "origin") ?? "—"}
          </p>
        </div>
      </div>
      <p className="cap">{t("inbox.doc.pipeline")}</p>
      <div className="chainbox-row">
        <span className="chainbox ok"><b>dream</b>{t("inbox.chain.collect")}</span>
        <span className="arrow">→</span>
        <span className="chainbox ok"><b>extract</b>{t("inbox.chain.extract")}</span>
        <span className="arrow">→</span>
        <span className="chainbox ok"><b>trust</b>{t("inbox.chain.intercept")}</span>
        <span className="arrow">→</span>
        <span className="chainbox now"><b>owner</b>{t("inbox.chain.owner")}</span>
        <span className="arrow">→</span>
        <span className="chainbox dashed"><b>page</b>{t("inbox.chain.effect")}</span>
      </div>
      {itemSummary(trust) && (
        <>
          <p className="cap">{t("inbox.doc.summary")}</p>
          <p className="doc-body">{itemSummary(trust)}</p>
        </>
      )}
      {trust.commands !== undefined && (
        <>
          <p className="cap">{t("inbox.doc.commands")}</p>
          <pre className="doc-raw">{JSON.stringify(trust.commands, null, 2)}</pre>
        </>
      )}
    </>
  );
}

// --- decision rail ---------------------------------------------------------------

function DecisionRail({
  entry,
  cliAvailable,
  cliCommand,
  canConfirm,
  act,
  takeCommands,
}: {
  entry: Entry;
  cliAvailable: boolean;
  /** the profile's command name for copy-command templates */
  cliCommand: string;
  /** live whoami capability; undefined = unknown (never guessed) */
  canConfirm?: boolean;
  /** server-built degraded-rail templates for the takes queue */
  takeCommands?: TakeQueueCommands;
  act: (
    path: string,
    body: unknown,
    auditText: string,
    stampState?: StampState,
    meta?: AuditMeta,
  ) => Promise<boolean>;
}) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  // the edge-lifecycle date input (persists across selections — an accidental
  // re-type is cheaper than losing a carefully-picked date)
  const [edgeDate, setEdgeDate] = useState("");

  // The single runtime source of truth for which channel an action travels
  // (shared/ADJUDICATION_CHANNELS) — the check card renders FROM the matrix,
  // so it can never disagree with the code that runs the action.
  const ch = (action: AdjudicationAction): string => ADJUDICATION_CHANNELS[action];

  const label = entry.title.slice(0, 80);
  const metaFor = (
    verdict: "stop" | "ok",
    verdictText: string,
    ref: string,
  ): AuditMeta => ({ ref, label, verdict, verdictText });

  let rail: ReactNode = null;
  let rows: ChannelRow[] = [];
  /** set for terminal-confirmation items: ⌘↵ copies it */
  let acceptCmd: string | null = null;
  /** set when the CLI one-key drop is live: ⌘⌫ runs it */
  let dropRun: (() => Promise<boolean>) | null = null;

  const stampDrop = (
    zhKey: MessageKey,
    enKey: MessageKey,
    how: string,
    run: () => Promise<boolean>,
  ) => (
    <StampButton
      variant="drop"
      zh={t(zhKey)}
      en={t(enKey)}
      how={how}
      onClick={() => void run()}
    />
  );

  const stampOk = (
    zhKey: MessageKey,
    enKey: MessageKey,
    how: string,
    run: () => Promise<boolean>,
  ) => (
    <StampButton
      variant="ok"
      zh={t(zhKey)}
      en={t(enKey)}
      how={how}
      onClick={() => void run()}
    />
  );

  // the green "accept" stamp (mockup .stamp-btn.copy): a copy shortcut for
  // the terminal-confirmation command — the verdict itself still only ever
  // happens at the owner's terminal (ENG-15), never through this click
  const copyStamp = (command: string) => (
    <StampButton
      variant="copy"
      zh={t("inbox.edgeAccept")}
      en={t("stamp.en.accept")}
      how={copied ? t("cmd.copied") : t("inbox.via.copy")}
      onClick={() => {
        void copyCommandText(command).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        });
      }}
    />
  );

  const rejectedStamp: StampState = {
    variant: "drop",
    zh: t("stamp.rejected"),
    en: t("stamp.en.rejected"),
  };
  const acceptedStamp: StampState = {
    variant: "ok",
    zh: t("stamp.accepted"),
    en: t("stamp.en.accepted"),
  };
  const confirmedStamp: StampState = {
    variant: "ok",
    zh: t("stamp.confirmed"),
    en: t("stamp.en.confirmed"),
  };

  switch (entry.queueId) {
    case "proposals":
    case "held": {
      const trust = entry.item as TrustReviewItem;
      const ref = safeRef(trust.ref);
      acceptCmd = ownerSafeCommand(
        entry.queueId === "proposals"
          ? itemCommand(trust, ["trust confirm"])
          : itemCommand(trust, ["trust release"]),
        entry.queueId === "proposals"
          ? trustConfirmCommand(cliCommand, ref)
          : trustReleaseCommand(cliCommand, ref),
        cliCommand,
      );
      dropRun = cliAvailable
        ? () =>
            act(
              "/api/inbox/trust/drop",
              { ref: trust.ref },
              `trust.drop ${trust.ref}`,
              rejectedStamp,
              metaFor("stop", t("verdict.rejected"), trust.ref ?? "?"),
            )
        : null;
      rail = (
        <>
          {dropRun
            ? stampDrop("inbox.drop", "stamp.en.drop", t("inbox.via.cliDrop"), dropRun)
            : null}
          {!cliAvailable ? (
            // degrade: one-key drop becomes a copy-command block too
            <CopyCommand command={trustDropCommand(cliCommand, ref)} />
          ) : null}
          {copyStamp(acceptCmd)}
          <CopyCommand command={acceptCmd} />
        </>
      );
      rows = [
        {
          label: t("channel.row.drop"),
          channel: ch("trust.proposal.drop"),
          verdict: cliAvailable ? "yes" : "na",
          note: cliAvailable ? t("channel.onekey") : t("channel.degraded"),
        },
        {
          label: entry.queueId === "proposals" ? t("channel.row.accept") : t("channel.row.release"),
          channel: entry.queueId === "proposals" ? ch("trust.proposal.accept") : ch("held-write.release"),
          verdict: "na",
          note: t("channel.terminal"),
        },
        { label: t("channel.row.mcp"), channel: "mcp", verdict: "na", note: t("channel.none") },
        { label: t("channel.row.db"), channel: "postgres", verdict: "no", note: t("channel.never") },
      ];
      break;
    }
    case "facts": {
      const trust = entry.item as TrustReviewItem;
      const ref = safeRef(trust.ref);
      rail = (
        <>
          {canConfirm === false ? (
            // known-missing memory_confirm scope: the stamp would only ever
            // 502 — show why instead of a button that cannot succeed
            <p className="confirm-readonly">{t("inbox.confirmReadOnly")}</p>
          ) : (
            stampOk("inbox.factConfirm", "stamp.en.confirm", t("inbox.via.mcp"), () =>
              act(
                "/api/inbox/confirm",
                { ref: trust.ref },
                `memory.confirm ${trust.ref}`,
                confirmedStamp,
                metaFor("ok", t("verdict.confirmed"), trust.ref ?? "?"),
              ),
            )
          )}
          {cliAvailable ? (
            stampDrop(
              "inbox.factDiscard",
              "stamp.en.discard",
              t("inbox.via.cliDrop"),
              (dropRun = () =>
                act(
                  "/api/inbox/trust/drop",
                  { ref: trust.ref },
                  `trust.drop ${trust.ref}`,
                  rejectedStamp,
                  metaFor("stop", t("verdict.rejected"), trust.ref ?? "?"),
                )),
            )
          ) : (
            <CopyCommand command={trustDropCommand(cliCommand, ref)} />
          )}
        </>
      );
      rows = [
        {
          label: t("channel.row.confirm"),
          channel: ch("memory.confirm"),
          // A read-grant profile (no memory_confirm scope) can never one-key
          // confirm — say na, and the note below explains the asymmetry:
          // this gates the MCP credential only, never the host CLI.
          verdict: canConfirm === false ? "na" : "yes",
          note:
            canConfirm === false
              ? t("inbox.confirmReadOnly")
              : t("channel.onekey"),
        },
        {
          label: t("channel.row.discard"),
          channel: ch("trust.proposal.drop"),
          verdict: cliAvailable ? "yes" : "na",
          note: cliAvailable ? t("channel.onekey") : t("channel.degraded"),
        },
        { label: t("channel.row.db"), channel: "postgres", verdict: "no", note: t("channel.never") },
      ];
      break;
    }
    case "edges": {
      const id = safeId(String((entry.item as EdgeProposal).id ?? ""));
      rail = cliAvailable && id !== "?" ? (
        <>
          {stampOk("inbox.edgeAccept", "stamp.en.accept", t("inbox.via.cliEdge"), () =>
            act(
              "/api/inbox/edge",
              { op: "accept", id },
              `edge.accept ${id}`,
              acceptedStamp,
              metaFor("ok", t("verdict.accepted"), `edge #${id}`),
            ),
          )}
          {stampDrop(
            "inbox.edgeReject",
            "stamp.en.reject",
            t("inbox.via.cliEdge"),
            (dropRun = () =>
              act(
                "/api/inbox/edge",
                { op: "reject", id },
                `edge.reject ${id}`,
                rejectedStamp,
                metaFor("stop", t("verdict.rejected"), `edge #${id}`),
              )),
          )}
          {/* date/undo complete the edge lifecycle (whitelisted all along) */}
          <div className="edge-extras">
            <input
              type="date"
              className="edge-date"
              aria-label={t("inbox.edgeDate")}
              value={edgeDate}
              onChange={(e) => setEdgeDate(e.target.value)}
            />
            <button
              type="button"
              className="small"
              disabled={!edgeDate}
              onClick={() =>
                void act(
                  "/api/inbox/edge",
                  { op: "date", id, date: edgeDate },
                  `edge.date ${id} ${edgeDate}`,
                  undefined,
                  metaFor("ok", t("inbox.edgeDateApply"), `edge #${id}`),
                )
              }
            >
              {t("inbox.edgeDateApply")}
            </button>
            <button
              type="button"
              className="small"
              title={t("inbox.edgeUndo")}
              onClick={() =>
                void act(
                  "/api/inbox/edge",
                  { op: "undo", id },
                  `edge.undo ${id}`,
                  undefined,
                  metaFor("ok", t("inbox.edgeUndo"), `edge #${id}`),
                )
              }
            >
              ↩ {t("inbox.edgeUndo")}
            </button>
          </div>
        </>
      ) : (
        <CopyCommand
          command={edgeAcceptCommand(cliCommand, id)}
          hint={t("inbox.edgeHint")}
        />
      );
      rows = [
        {
          label: t("channel.row.accept"),
          channel: ch("edge-proposals.accept"),
          verdict: cliAvailable ? "yes" : "na",
          note: cliAvailable ? t("channel.onekey") : t("channel.degraded"),
        },
        {
          label: t("channel.row.drop"),
          channel: ch("edge-proposals.reject"),
          verdict: cliAvailable ? "yes" : "na",
          note: cliAvailable ? t("channel.onekey") : t("channel.degraded"),
        },
        { label: t("channel.row.db"), channel: "postgres", verdict: "no", note: t("channel.never") },
      ];
      break;
    }
    case "takes": {
      const take = entry.item as TakeProposal;
      const id = safeId(String(take.id));
      // Degraded rail (CLI down): server-built, source-scoped command pairs —
      // on a multi-source brain the naive wrapper form pastes a guaranteed
      // not_found, so the templates carry GBRAIN_SOURCE/GBRAIN_HOME when the
      // profile has the direct-call pair, and otherwise the source is named
      // `unavailable` and we explain instead of pasting a known-bad command.
      const tpl = takeCommands?.bySource?.[take.source_id ?? "default"];
      const degradedCmds =
        !cliAvailable && tpl && id !== "?"
          ? {
              accept: tpl.accept.replace("{id}", id),
              reject: tpl.reject.replace("{id}", id),
            }
          : null;
      const pasteSafe =
        degradedCmds !== null &&
        TAKE_CMD_RE.test(degradedCmds.accept) &&
        TAKE_CMD_RE.test(degradedCmds.reject);
      if (degradedCmds && pasteSafe) acceptCmd = degradedCmds.accept;
      rail = cliAvailable ? (
        <>
          {stampOk("inbox.edgeAccept", "stamp.en.accept", t("inbox.via.cliTake"), () =>
            act(
              "/api/inbox/takes/propose",
              { op: "accept", id },
              `takes.propose.accept ${id}`,
              acceptedStamp,
              metaFor("ok", t("verdict.accepted"), `take #${id}`),
            ),
          )}
          {stampDrop(
            "inbox.drop",
            "stamp.en.reject",
            t("inbox.via.cliTake"),
            (dropRun = () =>
              act(
                "/api/inbox/takes/propose",
                { op: "reject", id },
                `takes.propose.reject ${id}`,
                rejectedStamp,
                metaFor("stop", t("verdict.rejected"), `take #${id}`),
              )),
          )}
        </>
      ) : degradedCmds && pasteSafe ? (
        <>
          <CopyCommand command={degradedCmds.accept} hint={t("inbox.takeHint")} />
          <CopyCommand
            command={degradedCmds.reject}
            hint={t("inbox.takeFinality")}
          />
        </>
      ) : (
        <p className="confirm-readonly">{t("inbox.takeUnscoped")}</p>
      );
      rows = [
        {
          label: t("channel.row.accept"),
          channel: ch("takes.propose.accept"),
          verdict: cliAvailable ? "yes" : "na",
          note: cliAvailable ? t("channel.onekey") : t("channel.degraded"),
        },
        {
          label: t("channel.row.drop"),
          channel: ch("takes.propose.reject"),
          verdict: cliAvailable ? "yes" : "na",
          note: cliAvailable ? t("channel.onekey") : t("channel.degraded"),
        },
        { label: t("channel.row.db"), channel: "postgres", verdict: "no", note: t("channel.never") },
      ];
      break;
    }
    case "judgments": {
      // the four-verdict stamp set (FEATURES §4.1's promise, finally true):
      // takes_resolve over MCP, one key per verdict, resolver stamped mcp:<client>
      const take = entry.item as TakeItem;
      const slug = stringField(take, "page_slug") ?? take.ref ?? "?";
      const row = typeof take.row_num === "number" ? take.row_num : undefined;
      const resolved = Boolean(take.resolved_outcome);
      const stampFor = (quality: TakeQuality, zhKey: MessageKey) =>
        stampOk(zhKey, "stamp.en.accept", t("inbox.judge.via"), () =>
          act(
            "/api/inbox/takes/resolve",
            { slug, row, quality },
            `takes.resolve ${slug}#${row} ${quality}`,
            {
              variant: "ok",
              zh: t(zhKey),
              en: quality,
            },
            metaFor("ok", t(zhKey), `${slug}#${row ?? "?"}`),
          ),
        );
      rail = row !== undefined && !resolved ? (
        <>
          {stampFor("correct", "inbox.judge.correct")}
          {stampFor("incorrect", "inbox.judge.incorrect")}
          {stampFor("partial", "inbox.judge.partial")}
          {stampFor("unresolvable", "inbox.judge.unresolvable")}
        </>
      ) : (
        <p className="confirm-readonly">
          {resolved
            ? `${t("inbox.judge.resolved")}: ${String(take.resolved_outcome)}`
            : t("inbox.queue.judgmentsDesc")}
        </p>
      );
      rows = [
        {
          label: t("inbox.judge.correct"),
          channel: ch("takes.resolve"),
          verdict: "yes",
          note: t("inbox.judge.via"),
        },
        {
          label: t("inbox.judge.incorrect"),
          channel: ch("takes.resolve"),
          verdict: "yes",
          note: t("inbox.judge.via"),
        },
        { label: t("channel.row.db"), channel: "postgres", verdict: "no", note: t("channel.never") },
      ];
      break;
    }
    case "extraction": {
      // read-only lane: extraction_review is owner-token-only upstream — the
      // rail explains instead of offering an action it cannot take
      rail = <p className="confirm-readonly">{t("inbox.extraction.readonly")}</p>;
      rows = [
        {
          label: t("channel.row.explain"),
          channel: "copy-command",
          verdict: "na",
          note: t("channel.terminal"),
        },
        { label: t("channel.row.db"), channel: "postgres", verdict: "no", note: t("channel.never") },
      ];
      break;
    }
    case "contradictions": {
      // decide rows: numeric id; their dp<id> trust-review twins: digits of ref
      const raw = entry.item as ContradictionProposal;
      const dpRef = stringField(raw, "ref") ?? "";
      const id = safeId(
        dpRef ? dpRef.replace(/^dp/, "") : String(raw.id ?? ""),
      );
      rail = cliAvailable && id !== "?" ? (
        <>
          {stampOk("inbox.edgeAccept", "stamp.en.accept", t("inbox.via.cliDecide"), () =>
            act(
              "/api/inbox/contradictions",
              { op: "accept", id },
              `contradictions.accept ${id}`,
              acceptedStamp,
              metaFor("ok", t("verdict.accepted"), `dp#${id}`),
            ),
          )}
          {stampDrop(
            "inbox.edgeReject",
            "stamp.en.reject",
            t("inbox.via.cliDecide"),
            (dropRun = () =>
              act(
                "/api/inbox/contradictions",
                { op: "reject", id },
                `contradictions.reject ${id}`,
                rejectedStamp,
                metaFor("stop", t("verdict.rejected"), `dp#${id}`),
              )),
          )}
        </>
      ) : (
        <>
          <CopyCommand
            command={contradictionAcceptCommand(cliCommand, id)}
            hint={t("inbox.contradiction.hint")}
          />
          <CopyCommand
            command={contradictionRejectCommand(cliCommand, id)}
            hint={t("inbox.contradiction.undoNote")}
          />
        </>
      );
      rows = [
        {
          label: t("channel.row.accept"),
          channel: ch("contradictions.accept"),
          verdict: cliAvailable ? "yes" : "na",
          note: cliAvailable ? t("channel.onekey") : t("channel.degraded"),
        },
        {
          label: t("channel.row.drop"),
          channel: ch("contradictions.reject"),
          verdict: cliAvailable ? "yes" : "na",
          note: cliAvailable ? t("channel.onekey") : t("channel.degraded"),
        },
        { label: t("channel.row.db"), channel: "postgres", verdict: "no", note: t("channel.never") },
      ];
      break;
    }
    default: {
      // others: explain only — read path, no adjudication surface here
      const trust = entry.item as TrustReviewItem;
      rail = (
        <CopyCommand
          command={trustExplainCommand(cliCommand, safeRef(trust.ref))}
        />
      );
      rows = [
        { label: t("channel.row.explain"), channel: "cli-whitelist", verdict: "na", note: t("channel.terminal") },
        { label: t("channel.row.db"), channel: "postgres", verdict: "no", note: t("channel.never") },
      ];
    }
  }

  // mockup keyboard affordances: ⌘⌫ = one-key drop (when the CLI channel is
  // live), ⌘↵ = copy the terminal-confirmation command. Both stay inert while
  // typing in inputs so they never eat editing keys.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!(e.metaKey || e.ctrlKey)) return;
      const target = e.target as HTMLElement | null;
      const typing =
        target !== null &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
      if (typing) return;
      if (e.key === "Enter" && acceptCmd) {
        e.preventDefault();
        void copyCommandText(acceptCmd).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        });
      } else if (e.key === "Backspace" && dropRun) {
        e.preventDefault();
        void dropRun();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return (
    <div className="rail">
      <p className="cap">{t("inbox.rail.caption")}</p>
      {rail}
      <ChannelMatrixCard rows={rows} />
    </div>
  );
}
