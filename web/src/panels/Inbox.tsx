import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ADJUDICATION_CHANNELS } from "@gbrain-cockpit/shared";
import type {
  AdjudicationAction,
  EdgeProposal,
  InboxReport,
  TakeProposal,
  TrustReviewItem,
} from "@gbrain-cockpit/shared";
import { AuditBlock } from "../components/AuditBlock";
import { ChannelMatrixCard, type ChannelRow } from "../components/ChannelMatrixCard";
import { CopyCommand } from "../components/CopyCommand";
import { StampButton } from "../components/StampButton";
import { Tag, type TagVariant } from "../components/Tag";
import { TrustChain } from "../components/TrustChain";
import { VerdictHistory } from "../components/VerdictHistory";
import { appendAudit, type AuditMeta } from "../lib/auditLog";
import { copyCommandText } from "../lib/clipboard";
import { ApiError, apiGet, apiSend } from "../lib/api";
import { useI18n, type MessageKey } from "../lib/i18n";

// Inbox — the adjudication desk, in the frozen v5 interaction model:
// queue tabs | queue-card list | document + decision rail, with the stamp
// drop as the brand moment and the ink audit block as the fixed receipt
// slot. The action trichotomy is STRUCTURAL (style-review hard constraint):
// one-key actions are stamp buttons, terminal-confirmation actions are
// ALWAYS copy-command blocks (owner-presence, gbrain ENG-15 — never batched,
// never a button), and when the CLI channel is unavailable on this host,
// CLI one-key actions degrade to copy-command blocks too.

type QueueId = "proposals" | "held" | "facts" | "edges" | "takes" | "others";
type TabId = "all" | Exclude<QueueId, "others">;

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

/** Errors shown to the browser stay one line — full text is server-log only. */
function firstLine(error?: string): string {
  if (!error) return "";
  return (error.split("\n").find((l) => l.trim()) ?? "").slice(0, 220);
}

function stringField(item: object, key: string): string | undefined {
  const v = (item as Record<string, unknown>)[key];
  return typeof v === "string" && v.trim() ? v : undefined;
}

export function Inbox({
  onOpenPage,
  onTotal,
}: {
  onOpenPage?: (slug: string) => void;
  /** sidebar count chip — reported after every fetch, no extra request */
  onTotal?: (total: number) => void;
}) {
  const { t } = useI18n();
  const [report, setReport] = useState<InboxReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [tab, setTab] = useState<TabId>("all");
  const [detail, setDetail] = useState<Entry | null>(null);
  const [stamp, setStamp] = useState<StampState | null>(null);

  const refresh = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      setReport(await apiGet<InboxReport>("/api/inbox"));
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

  const cliAvailable = report?.cliChannel.available === true;
  const trustItems = report?.trust.items ?? [];
  const proposals = trustItems.filter((i) => (i.ref ?? "").startsWith("tp"));
  const heldWrites = trustItems.filter((i) => (i.ref ?? "").startsWith("h"));
  const facts = trustItems.filter((i) => (i.ref ?? "").startsWith("f"));
  const others = trustItems.filter((i) => {
    const r = i.ref ?? "";
    return r && !r.startsWith("tp") && !r.startsWith("h") && !r.startsWith("f");
  });
  const edges = report?.edgeProposals.items ?? [];
  const takes = report?.takes.items ?? [];

  const queueCounts: Record<QueueId, number> = {
    proposals: proposals.length,
    held: heldWrites.length,
    facts: facts.length,
    edges: edges.length,
    takes: takes.length,
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
        queueCounts.others,
    );
  }, [report]); // onTotal is a stable state setter from the shell

  // --- entry assembly --------------------------------------------------------

  function trustEntry(queueId: "proposals" | "held" | "facts" | "others", item: TrustReviewItem): Entry {
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
      tags: [
        { variant: "soft", text: t("inbox.queue.takes") },
        ...(take.kind ? [{ variant: "plain" as TagVariant, text: take.kind }] : []),
        ...(take.holder ? [{ variant: "warn" as TagVariant, text: take.holder }] : []),
      ],
      srcLines: [take.page_slug, take.model_id ?? ""].filter(Boolean),
      item: take,
    };
  }

  const allEntries: Entry[] = [
    ...proposals.map((i) => trustEntry("proposals", i)),
    ...heldWrites.map((i) => trustEntry("held", i)),
    ...facts.map((i) => trustEntry("facts", i)),
    ...edges.map(edgeEntry),
    ...takes.map(takeEntry),
    ...others.map((i) => trustEntry("others", i)),
  ];
  const visibleEntries =
    tab === "all" ? allEntries : allEntries.filter((e) => e.queueId === tab);

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
      if (stampState) setStamp(stampState);
      await refresh();
      return true;
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : String(err);
      appendAudit(`${auditText} -> ERR ${firstLine(msg)}`);
      setActionError(msg);
      return false;
    }
  }

  function select(entry: Entry) {
    setDetail(entry);
    setStamp(null);
  }

  const tabs: { id: TabId; label: string; n: number }[] = [
    { id: "all", label: t("inbox.tab.all"), n: allEntries.length },
    { id: "proposals", label: t("inbox.queue.proposals"), n: queueCounts.proposals },
    { id: "held", label: t("inbox.queue.held"), n: queueCounts.held },
    { id: "facts", label: t("inbox.queue.facts"), n: queueCounts.facts },
    { id: "edges", label: t("inbox.queue.edges"), n: queueCounts.edges },
    { id: "takes", label: t("inbox.queue.takes"), n: queueCounts.takes },
  ];

  return (
    <section className="panel inbox">
      <nav className="tabs" aria-label={t("panel.inbox.title")}>
        {tabs.map((tb) => (
          <button
            key={tb.id}
            type="button"
            className={`tab ${tab === tb.id ? "on" : ""}`}
            aria-pressed={tab === tb.id}
            onClick={() => setTab(tb.id)}
          >
            {tb.label}{" "}
            <span className="n">
              {tb.id !== "all" && queueDown[tb.id] !== undefined ? "?" : tb.n}
            </span>
          </button>
        ))}
      </nav>

      <div className="inbox-meta">
        <p className="panel-desc">{t("panel.inbox.desc")}</p>
        <div className="list-tools">
          <span className={`chip ${cliAvailable ? "chip-ok" : "chip-degraded"}`}>
            {cliAvailable ? t("inbox.cliOk") : t("inbox.cliDegraded")}
          </span>
          <button type="button" onClick={() => void refresh()} disabled={busy}>
            {busy ? t("common.loading") : t("health.refresh")}
          </button>
        </div>
      </div>

      {error && <p className="error inbox-error">{error}</p>}
      {actionError && (
        <p className="error inbox-error" role="alert">
          {firstLine(actionError)}
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
            </div>
            {downNotices(tab).map((err, i) => (
              <p key={i} className="muted empty-note">
                {t("inbox.queueUnavailable")}: {err}
              </p>
            ))}
            {visibleEntries.length === 0 && downNotices(tab).length === 0 && (
              <p className="muted empty-note">{t("inbox.empty")}</p>
            )}
            {visibleEntries.map((entry) => (
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
                    <DocumentCard entry={detail} onOpenPage={onOpenPage} />
                    {stamp ? (
                      <div className={`big-stamp ${stamp.variant}`}>
                        <span className="zh">{stamp.zh}</span>
                        <span className="en">{stamp.en}</span>
                      </div>
                    ) : null}
                  </div>
                  <DecisionRail
                    entry={detail}
                    cliAvailable={cliAvailable}
                    act={act}
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

// --- document card -------------------------------------------------------------

function DocumentCard({
  entry,
  onOpenPage,
}: {
  entry: Entry;
  onOpenPage?: (slug: string) => void;
}) {
  const { t } = useI18n();
  const item = entry.item;

  if (entry.queueId === "edges") {
    return (
      <>
        <div className="doc-head">
          <div>
            <h2>{entry.title}</h2>
            <p className="refline mono">{entry.ref} · {t("inbox.queue.edges")}</p>
          </div>
          <div className="to">
            <div className="mono to-cap">TARGET</div>
            <b>{entry.target ?? "—"}</b>
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
            {onOpenPage ? (
              <button
                type="button"
                className="linkish to-link"
                onClick={() => onOpenPage(take.page_slug)}
              >
                {take.page_slug}
              </button>
            ) : (
              <b>{take.page_slug}</b>
            )}
            <div className="mono to-cap">take #{take.id}</div>
          </div>
        </div>
        <div className="meta3">
          <div>
            <p className="k">KIND</p>
            <p className="v">{take.kind ?? "?"}</p>
          </div>
          <div>
            <p className="k">HOLDER</p>
            <p className="v">{take.holder ?? "?"}</p>
          </div>
          <div>
            <p className="k">WEIGHT · DOMAIN</p>
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
          <div className="mono to-cap">TARGET</div>
          <b>{entry.target ?? t("inbox.doc.unknownTarget")}</b>
          {revision ? <div className="mono to-cap">rev {revision}</div> : null}
        </div>
      </div>
      <div className="meta3">
        <div>
          <p className="k">REF</p>
          <p className="v mono">{trust.ref ?? "?"}</p>
        </div>
        <div>
          <p className="k">KIND</p>
          <p className="v">{stringField(trust, "kind") ?? "?"}</p>
        </div>
        <div>
          <p className="k">SOURCE</p>
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
  act,
}: {
  entry: Entry;
  cliAvailable: boolean;
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

  const stampDrop = (how: string, run: () => Promise<boolean>) => (
    <StampButton
      variant="drop"
      zh={t("inbox.drop")}
      en="DROP"
      how={how}
      onClick={() => void run()}
    />
  );

  const stampOk = (
    zhKey: MessageKey,
    en: string,
    how: string,
    run: () => Promise<boolean>,
  ) => (
    <StampButton
      variant="ok"
      zh={t(zhKey)}
      en={en}
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
      en="ACCEPT"
      how={copied ? t("cmd.copied") : t("inbox.via.copy")}
      onClick={() => {
        void copyCommandText(command).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        });
      }}
    />
  );

  const rejectedStamp: StampState = { variant: "drop", zh: t("stamp.rejected"), en: "REJECTED" };
  const acceptedStamp: StampState = { variant: "ok", zh: t("stamp.accepted"), en: "ACCEPTED" };
  const confirmedStamp: StampState = { variant: "ok", zh: t("stamp.confirmed"), en: "CONFIRMED" };

  switch (entry.queueId) {
    case "proposals":
    case "held": {
      const trust = entry.item as TrustReviewItem;
      acceptCmd =
        entry.queueId === "proposals"
          ? itemCommand(trust, ["trust confirm"]) ?? `gbrain trust confirm ${trust.ref}`
          : itemCommand(trust, ["trust release"]) ?? `gbrain trust release ${trust.ref}`;
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
          {dropRun ? stampDrop(t("inbox.via.cliDrop"), dropRun) : null}
          {!cliAvailable ? (
            // degrade: one-key drop becomes a copy-command block too
            <CopyCommand command={`gbrain trust drop ${trust.ref}`} />
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
      rail = (
        <>
          {stampOk("inbox.factConfirm", "CONFIRM", t("inbox.via.mcp"), () =>
            act(
              "/api/inbox/confirm",
              { ref: trust.ref },
              `memory.confirm ${trust.ref}`,
              confirmedStamp,
              metaFor("ok", t("verdict.confirmed"), trust.ref ?? "?"),
            ),
          )}
          {cliAvailable ? (
            stampDrop(
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
            <CopyCommand command={`gbrain trust drop ${trust.ref}`} />
          )}
        </>
      );
      rows = [
        {
          label: t("channel.row.confirm"),
          channel: ch("memory.confirm"),
          verdict: "yes",
          note: t("channel.onekey"),
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
      const id = String((entry.item as EdgeProposal).id ?? "");
      rail = cliAvailable && id ? (
        <>
          {stampOk("inbox.edgeAccept", "ACCEPT", t("inbox.via.cliEdge"), () =>
            act(
              "/api/inbox/edge",
              { op: "accept", id },
              `edge.accept ${id}`,
              acceptedStamp,
              metaFor("ok", t("verdict.accepted"), `edge #${id}`),
            ),
          )}
          {stampDrop(
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
        </>
      ) : (
        <CopyCommand
          command={`gbrain edge-proposals accept ${id}`}
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
      const id = String(take.id);
      rail = cliAvailable ? (
        <>
          {stampOk("inbox.edgeAccept", "ACCEPT", t("inbox.via.cliTake"), () =>
            act(
              "/api/inbox/takes/propose",
              { op: "accept", id },
              `takes.propose.accept ${id}`,
              acceptedStamp,
              metaFor("ok", t("verdict.accepted"), `take #${id}`),
            ),
          )}
          {stampDrop(
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
      ) : (
        <CopyCommand
          command={`gbrain takes propose --accept ${id}`}
          hint={t("inbox.takeHint")}
        />
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
    default: {
      // others: explain only — read path, no adjudication surface here
      const trust = entry.item as TrustReviewItem;
      rail = <CopyCommand command={`gbrain trust explain ${trust.ref}`} />;
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
