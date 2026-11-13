import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ASK_THINK_COST_BRACKET,
  ASK_THINK_TIMEOUT_MS,
  type AskEvidenceReport,
  type AskEvidenceRow,
  type AskMissingReport,
  type AskThinkReport,
} from "@gbrain-cockpit/shared";
import { apiGet, apiSend, ApiError } from "../lib/api";
import { useI18n, type MessageKey } from "../lib/i18n";
import type { PageRef } from "../lib/pages";
import {
  chipLabel,
  classifyCitations,
  evidenceTitle,
  formatElapsed,
  formatSeconds,
  isNoAnswer,
  KNOWN_TRUST_TIERS,
  KNOWN_TYPES,
  shortDate,
  splitExcerpt,
  splitSlugMarkers,
  waitTier,
  type ChipRef,
  type TextRun,
} from "../lib/askTape";
import { marked, type Token, type Tokens } from "marked";
import { CopyCommand } from "../components/CopyCommand";

// 问一句 (ASK) — the chart recorder. One tape per question, printed in the
// order things happened: question → evidence (free, ~2s) → paid seam →
// writing (36–95s, one blocking call — no fake progress) → answer → gaps.
// Design authority: internal/mockups/ask-panel/设计定案.md (direction 3).
// Shape authority: internal/probes/ask-panel-0.60.611-20261113.json.

// --- markdown → React token tree (structural zero-innerHTML, §9) ---------------
// The design contract says marked→DOMPurify + chip backfill. Rendering the
// marked TOKEN TREE as React nodes meets both clauses structurally: no HTML
// string is ever built (React text nodes escape by construction — a stronger
// guarantee than sanitizing after the fact), and chips are real DOM nodes
// placed during the walk, not backfilled into sanitized HTML. Brain-content
// links render as their TEXT (untrusted — never an anchor, never navigation);
// the only jumps from a chip go through cockpit's own internal routing.

type ChipProps = {
  ref_: ChipRef;
  row?: AskEvidenceRow;
  pagesGathered?: number;
  onJump: (slug: string) => void;
  onOpenPage: (ref: PageRef) => void;
};

function Chip({ ref_, row, pagesGathered, onJump, onOpenPage }: ChipProps) {
  const { t } = useI18n();
  const onTape = ref_.kind === "tape";
  const tip = onTape && row ? (
    <>
      <span className="slug">
        {row.slug}
        {row.source_id !== undefined ? ` · ${t("ask.cite.src")} ${row.source_id}` : ""}
        <span className="tr">{row.trust_tier !== undefined ? trustLabel(t, row.trust_tier) : ""}</span>
      </span>
      {row.chunk_text !== undefined ? <span className="xc">{row.chunk_text}</span> : null}
      <span className="go">{t("ask.chip.tipGo")}</span>
    </>
  ) : ref_.kind === "brain" ? (
    <>
      <span className="slug">{ref_.slug}<span className="tr">{t("ask.chip.brainTag").replace("{n}", String(pagesGathered ?? "—"))}</span></span>
      <span className="xc">{t("ask.chip.brain.body").replace("{n}", String(pagesGathered ?? "—"))}</span>
      <span className="go">{t("ask.chip.brain.go")}</span>
    </>
  ) : (
    <>
      <span className="slug">{ref_.slug}</span>
      <span className="xc">{t("ask.chip.gapOnly.body")}</span>
      <span className="go">{t("ask.chip.brain.go")}</span>
    </>
  );
  return (
    <span
      className={`pcite ${onTape ? "" : "brain"}`}
      tabIndex={0}
      onClick={(e) => {
        e.stopPropagation();
        if (onTape) onJump(ref_.slug);
        else onOpenPage({ slug: ref_.slug, ...(ref_.sourceId !== undefined ? { sourceId: ref_.sourceId } : {}) });
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          if (onTape) onJump(ref_.slug);
          else onOpenPage({ slug: ref_.slug, ...(ref_.sourceId !== undefined ? { sourceId: ref_.sourceId } : {}) });
        }
      }}
    >
      <span className="tip">{tip}</span>
      {chipLabel(ref_)}
    </span>
  );
}

/** one inline text run: prose + chips (only KNOWN slugs become chips — an
 *  unknown bracket renders verbatim, no guessing) */
function TextWithChips({
  text,
  refs,
  rows,
  pagesGathered,
  onJump,
  onOpenPage,
}: {
  text: string;
  refs: Map<string, ChipRef>;
  rows: AskEvidenceRow[];
  pagesGathered?: number;
  onJump: (slug: string) => void;
  onOpenPage: (ref: PageRef) => void;
}) {
  const runs = splitSlugMarkers(text);
  const rowBySlug = useMemo(() => new Map(rows.map((r) => [r.slug, r])), [rows]);
  return (
    <>
      {runs.map((run: TextRun, i) =>
        "text" in run ? (
          run.text
        ) : refs.has(run.slug) ? (
          <Chip
            key={i}
            ref_={refs.get(run.slug)!}
            row={rowBySlug.get(run.slug)}
            pagesGathered={pagesGathered}
            onJump={onJump}
            onOpenPage={onOpenPage}
          />
        ) : (
          `[${run.slug}]`
        ),
      )}
    </>
  );
}

/** walk marked's INLINE token list: text (chip-split), codespan, strong, em;
 *  links degrade to their text (untrusted content never navigates) */
function InlineTokens({
  tokens,
  refs,
  rows,
  pagesGathered,
  onJump,
  onOpenPage,
}: {
  tokens: Token[] | undefined;
  refs: Map<string, ChipRef>;
  rows: AskEvidenceRow[];
  pagesGathered?: number;
  onJump: (slug: string) => void;
  onOpenPage: (ref: PageRef) => void;
}) {
  if (!tokens) return null;
  const shared = { refs, rows, pagesGathered, onJump, onOpenPage };
  return (
    <>
      {tokens.map((tok, i) => {
        switch (tok.type) {
          case "text":
            return (
              <TextWithChips key={i} text={(tok as Tokens.Text).text} {...shared} />
            );
          case "codespan":
            return <code key={i}>{(tok as Tokens.Codespan).text}</code>;
          case "strong":
            return <b key={i}><InlineTokens tokens={(tok as Tokens.Strong).tokens} {...shared} /></b>;
          case "em":
            return <i key={i}><InlineTokens tokens={(tok as Tokens.Em).tokens} {...shared} /></i>;
          case "del":
            return <s key={i}><InlineTokens tokens={(tok as Tokens.Del).tokens} {...shared} /></s>;
          case "link":
            // untrusted href — the anchor never renders; its text does
            return <InlineTokens key={i} tokens={(tok as Tokens.Link).tokens} {...shared} />;
          case "br":
            return <br key={i} />;
          default:
            return "text" in tok && typeof tok.text === "string"
              ? <TextWithChips key={i} text={tok.text} {...shared} />
              : null;
        }
      })}
    </>
  );
}

/** marked BLOCK tokens → React nodes. think answers (probed) are headings,
 *  paragraphs and lists; anything exotic falls back to its raw text. */
function AnswerProse(props: {
  markdown: string;
  refs: Map<string, ChipRef>;
  rows: AskEvidenceRow[];
  pagesGathered?: number;
  onJump: (slug: string) => void;
  onOpenPage: (ref: PageRef) => void;
}) {
  const tokens = marked.lexer(props.markdown, { gfm: true, breaks: true });
  const shared = {
    refs: props.refs,
    rows: props.rows,
    pagesGathered: props.pagesGathered,
    onJump: props.onJump,
    onOpenPage: props.onOpenPage,
  };
  return (
    <div className="prose">
      {tokens.map((tok, i) => {
        switch (tok.type) {
          case "heading":
            return (
              <h3 key={i}>
                <InlineTokens tokens={(tok as Tokens.Heading).tokens} {...shared} />
              </h3>
            );
          case "paragraph":
            return (
              <p key={i}>
                <InlineTokens tokens={(tok as Tokens.Paragraph).tokens} {...shared} />
              </p>
            );
          case "list":
            return (
              <ul key={i}>
                {(tok as Tokens.List).items.map((item, j) => (
                  <li key={j}>
                    <InlineTokens tokens={item.tokens} {...shared} />
                  </li>
                ))}
              </ul>
            );
          case "code":
            return <pre key={i} className="mono">{(tok as Tokens.Code).text}</pre>;
          case "blockquote":
            return (
              <p key={i} className="quote">
                <InlineTokens tokens={(tok as Tokens.Blockquote).tokens} {...shared} />
              </p>
            );
          case "hr":
            return null;
          default:
            return "text" in tok && typeof tok.text === "string" ? (
              <p key={i}>
                <TextWithChips text={tok.text} {...shared} />
              </p>
            ) : null;
        }
      })}
    </div>
  );
}

// --- enum labels (known → human word; unknown → raw value, mono by CSS) --------

function typeLabel(t: ReturnType<typeof useI18n>["t"], type: string | undefined): string {
  if (type === undefined) return "";
  return (KNOWN_TYPES as readonly string[]).includes(type)
    ? t(`ask.type.${type}` as MessageKey)
    : type;
}

function trustLabel(t: ReturnType<typeof useI18n>["t"], tier: string | undefined): string {
  if (tier === undefined) return "";
  return (KNOWN_TRUST_TIERS as readonly string[]).includes(tier)
    ? t(`ask.trust.${tier}` as MessageKey)
    : tier;
}

// --- tape model -----------------------------------------------------------------

type Phase = "evidence" | "waiting" | "answer" | "fail" | "keyless";

interface Tape {
  id: number;
  question: string;
  askedAt: number;
  evidence: AskEvidenceReport | null;
  runStartedAt: number | null;
  result: AskThinkReport | null;
  /** cut-the-tape receipt (fixed slot in the seam, never a toast) */
  receipt: { elapsedMs: number } | null;
}

function phaseOf(tape: Tape | null): Phase | "empty" {
  if (!tape) return "empty";
  if (tape.runStartedAt !== null) return "waiting";
  if (tape.result === null) return "evidence";
  if (tape.result.status === "ok") return "answer";
  if (tape.result.status === "keyless") return "keyless";
  return "fail";
}

interface HistoryEntry {
  question: string;
  stamp: "answered" | "noanswer" | "failed" | "keyless" | "cancelled";
  seconds: string;
}

function stampOf(tape: Tape, noAnswer: boolean): HistoryEntry["stamp"] {
  if (tape.result === null) return "cancelled";
  if (tape.result.status === "keyless") return "keyless";
  if (tape.result.status === "down") return "failed";
  return noAnswer ? "noanswer" : "answered";
}

const clock = (at: number) =>
  new Date(at).toTimeString().slice(0, 8);

// --- the panel --------------------------------------------------------------------

export function Ask({
  active,
  onOpenPage,
  onOpenAdmin,
}: {
  /** keep-alive slot: the tape survives tab switches; the clock keeps ticking */
  active: boolean;
  onOpenPage: (ref: PageRef) => void;
  onOpenAdmin: () => void;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = useState("");
  const [tape, setTape] = useState<Tape | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [evidenceBusy, setEvidenceBusy] = useState(false);
  const [seamDismissed, setSeamDismissed] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [widened, setWidened] = useState<Map<string, string>>(new Map());
  const [widenBusy, setWidenBusy] = useState(false);
  const [missingTarget, setMissingTarget] = useState("");
  const [missingBusy, setMissingBusy] = useState(false);
  const [missing, setMissing] = useState<AskMissingReport | null>(null);
  const [gapFocus, setGapFocus] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const seamRef = useRef<HTMLDivElement | null>(null);
  const rowRefs = useRef(new Map<string, HTMLDivElement | null>());
  const gapsRef = useRef<HTMLDivElement | null>(null);
  const tapeId = useRef(0);

  const phase = phaseOf(tape);
  const noAnswer =
    phase === "answer" && tape?.evidence !== null &&
    isNoAnswer(tape?.evidence?.rows ?? []);
  const waiting = phase === "waiting";

  // the wait clock ticks only while writing (and across keep-alive hides)
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [waiting]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const pushHistory = useCallback((entry: HistoryEntry) => {
    setHistory((h) => [entry, ...h].slice(0, 12));
  }, []);

  /** free leg: print a new tape (the old one files into the session box) */
  const runTape = useCallback(
    async (question: string, direct: boolean) => {
      if (waiting || evidenceBusy) return;
      if (tape) {
        const wasNoAnswer =
          phaseOf(tape) === "answer" && isNoAnswer(tape.evidence?.rows ?? []);
        pushHistory({
          question: tape.question,
          stamp: stampOf(tape, wasNoAnswer),
          seconds: tape.result?.tookMs !== undefined
            ? formatSeconds(tape.result.tookMs)
            : tape.evidence !== null
              ? formatSeconds(tape.evidence.tookMs)
              : "—",
        });
      }
      setSeamDismissed(false);
      setExpanded(new Set());
      setWidened(new Map());
      setMissing(null);
      setMissingTarget("");
      const id = ++tapeId.current;
      const askedAt = Date.now();
      setTape({ id, question, askedAt, evidence: null, runStartedAt: null, result: null, receipt: null });
      setEvidenceBusy(true);
      try {
        const report = await apiGet<AskEvidenceReport>(
          `/api/ask?q=${encodeURIComponent(question)}`,
        );
        setTape((cur) =>
          cur && cur.id === id ? { ...cur, evidence: report } : cur,
        );
      } catch (err) {
        setTape((cur) =>
          cur && cur.id === id
            ? {
                ...cur,
                evidence: {
                  status: "down",
                  rows: [],
                  tookMs: 0,
                  error: err instanceof ApiError ? err.message : String(err),
                },
              }
            : cur,
        );
      } finally {
        setEvidenceBusy(false);
      }
      if (direct) {
        // 护栏(定案钉死):直达深答省的是「等证据摆完」,不是盖章——滚到付费缝
        requestAnimationFrame(() =>
          seamRef.current?.scrollIntoView({ block: "center", behavior: "smooth" }),
        );
      }
    },
    [waiting, evidenceBusy, tape, pushHistory],
  );

  const submit = useCallback(() => {
    const q = draft.trim();
    if (!q || waiting || evidenceBusy) return;
    setDraft("");
    void runTape(q, false);
  }, [draft, waiting, evidenceBusy, runTape]);

  const direct = useCallback(() => {
    const q = draft.trim();
    if (!q || waiting || evidenceBusy) return;
    setDraft("");
    void runTape(q, true);
  }, [draft, waiting, evidenceBusy, runTape]);

  /** paid leg: the stamp. One call + timer + cancel — never polling */
  const stamp = useCallback(async () => {
    if (!tape || waiting) return;
    const id = tape.id;
    const question = tape.question;
    const controller = new AbortController();
    abortRef.current = controller;
    const startedAt = Date.now();
    setTape((cur) => (cur && cur.id === id ? { ...cur, runStartedAt: startedAt } : cur));
    try {
      const report = await apiSend<AskThinkReport>(
        "/api/ask/think",
        "POST",
        { question, confirm: true },
        // server budget + transport headroom over ASK_THINK_TIMEOUT_MS
        { timeoutMs: ASK_THINK_TIMEOUT_MS + 20_000, signal: controller.signal },
      );
      setTape((cur) => (cur && cur.id === id ? { ...cur, runStartedAt: null, result: report } : cur));
    } catch (err) {
      if (controller.signal.aborted) {
        // 剪带:回到证据态,收据落缝(钱可能已花——文案不弱化)
        setTape((cur) =>
          cur && cur.id === id
            ? { ...cur, runStartedAt: null, result: null, receipt: { elapsedMs: Date.now() - startedAt } }
            : cur,
        );
      } else {
        setTape((cur) =>
          cur && cur.id === id
            ? {
                ...cur,
                runStartedAt: null,
                result: {
                  status: "down",
                  error: err instanceof ApiError ? err.message : String(err),
                },
              }
            : cur,
        );
      }
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  }, [tape, waiting]);

  const cut = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  /** chip jump: scroll to the evidence row + amber flash ×2 */
  const jumpToRow = useCallback((slug: string) => {
    const row = rowRefs.current.get(slug);
    if (!row) return;
    row.scrollIntoView({ block: "center", behavior: "smooth" });
    row.classList.remove("flash");
    void row.offsetWidth; // restart the animation
    row.classList.add("flash");
  }, []);

  const focusGaps = useCallback(() => {
    setGapFocus(true);
    gapsRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
    setTimeout(() => setGapFocus(false), 3200);
  }, []);

  /** widen: reuse /api/evidence (assemble_evidence, ≤3 triples, free) */
  const widen = useCallback(async () => {
    if (!tape?.evidence || widenBusy) return;
    const rows = tape.evidence.rows.slice(0, 3);
    const hits = rows
      .filter((r) => r.source_id !== undefined && typeof r.chunk_id === "number")
      .map((r) => ({ source_id: r.source_id!, slug: r.slug, chunk_id: r.chunk_id! }));
    if (hits.length === 0) return;
    setWidenBusy(true);
    try {
      const payload = await apiSend<{ status: string; results?: Array<{ slug?: string; chunk_text?: string }> }>(
        "/api/evidence",
        "POST",
        { hits },
      );
      const next = new Map<string, string>();
      for (const r of payload.results ?? []) {
        if (typeof r.slug === "string" && typeof r.chunk_text === "string") {
          next.set(r.slug, r.chunk_text);
        }
      }
      setWidened((cur) => new Map([...cur, ...next]));
    } catch {
      // widen is a free courtesy — a failure leaves the table exactly as-is
    } finally {
      setWidenBusy(false);
    }
  }, [tape, widenBusy]);

  const askMissing = useCallback(async () => {
    const target = missingTarget.trim();
    if (!tape || !target || missingBusy) return;
    setMissingBusy(true);
    try {
      const report = await apiSend<AskMissingReport>(
        "/api/ask/missing",
        "POST",
        { q: tape.question, target },
      );
      setMissing(report);
    } catch (err) {
      setMissing({
        status: "down",
        target,
        lines: [],
        error: err instanceof ApiError ? err.message : String(err),
      });
    } finally {
      setMissingBusy(false);
    }
  }, [tape, missingTarget, missingBusy]);

  // citation map for the current tape's answer
  const refs = useMemo(() => {
    if (!tape?.result?.result) return new Map<string, ChipRef>();
    return classifyCitations(tape.evidence?.rows ?? [], tape.result.result);
  }, [tape]);

  // --- odometers -----------------------------------------------------------------
  const elapsedText =
    phase === "empty" ? "—"
    : waiting ? formatElapsed(now - (tape?.runStartedAt ?? now))
    : tape?.result?.tookMs !== undefined ? `${formatSeconds(tape.result.tookMs)}s`
    : tape?.evidence ? `${formatSeconds(tape.evidence.tookMs)}s`
    : "—";
  const usage = tape?.result?.result?.usage;
  // evidence lamp: lit once the free leg has run on this tape (states 2–8);
  // deep lamp: breathing while writing (CSS), solid once the brain answered
  const evidenceLampOn = phase !== "empty";
  const deepLampOn = phase === "answer" || phase === "keyless";

  return (
    <section className="ask" aria-busy={waiting}>
      {/* ============ 仪器控制头 ============ */}
      <div className="console brut">
        <div className="row1">
          <div className="cap">{t("ask.console.cap")}</div>
          <input
            type="text"
            value={draft}
            maxLength={400}
            aria-label={t("nav.ask.zh")}
            placeholder={t("ask.placeholder")}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
            }}
          />
          <button
            type="button"
            className="btn-main btn-press"
            disabled={waiting || evidenceBusy || !draft.trim()}
            onClick={submit}
          >
            {waiting ? t("ask.wait.submitLocked") : t("ask.submit")}
          </button>
          <button
            type="button"
            className="btn-paid btn-press"
            disabled={waiting || evidenceBusy || !draft.trim()}
            onClick={direct}
          >
            {t("ask.direct")}
            <span className="sub">{t("ask.direct.sub")}</span>
          </button>
        </div>
        <div className="row2">
          <span className={`lamp ${evidenceLampOn ? "on" : ""}`}>
            <span className="dot" />
            {t("ask.lamp.evidence")}
          </span>
          <span className={`lamp pay ${waiting || deepLampOn ? "on" : ""}`}>
            <span className="dot" />
            {t("ask.lamp.deep")}
          </span>
          <span className="odo">
            <span className="cell"><span className="lab">{t("ask.odo.elapsed")}</span><span className="n">{elapsedText}</span></span>
            <span className="cell"><span className="lab">{t("ask.odo.in")}</span><span className="n">{waiting ? "…" : (usage?.input_tokens === undefined ? "—" : usage.input_tokens.toLocaleString("en-US"))}</span></span>
            <span className="cell"><span className="lab">{t("ask.odo.out")}</span><span className="n">{waiting ? "…" : (usage?.output_tokens === undefined ? "—" : usage.output_tokens.toLocaleString("en-US"))}</span></span>
            <span className="cell"><span className="lab">{t("ask.odo.pages")}</span><span className="n">{waiting ? "…" : (tape?.result?.result?.pagesGathered === undefined ? (tape?.evidence ? String(tape.evidence.rows.length) : "—") : String(tape.result.result.pagesGathered))}</span></span>
          </span>
        </div>
        <div className="why">{t("ask.console.why")}</div>
      </div>

      {/* ============ 纸带 ============ */}
      <div className="tape-wrap">
        <div className="tape">
          <div className="tape-inner">
            {phase === "empty" ? <EmptyTape history={history} /> : null}

            {tape ? (
              <>
                {/* 问句段 */}
                <div className="seg seg-q">
                  <div className="seg-head">
                    <span className="mark">▸ {clock(tape.askedAt)}</span>
                    <span className="t">{t("ask.seg.question")}</span>
                    <span className="right mono dim10">{t("ask.seg.question.meta")}</span>
                  </div>
                  <div className="q-big">{tape.question}</div>
                </div>

                {/* 证据段(印上就不消失:证据态/在写/答案/答不出变体各自成形) */}
                <EvidenceSegment
                    tape={tape}
                    noAnswer={noAnswer}
                    expanded={expanded}
                    onToggle={(slug) =>
                      setExpanded((cur) => {
                        const next = new Set(cur);
                        if (next.has(slug)) next.delete(slug);
                        else next.add(slug);
                        return next;
                      })
                    }
                    registerRow={(slug, el) => rowRefs.current.set(slug, el)}
                    refs={refs}
                    widened={widened}
                    onOpenPage={onOpenPage}
                    widenBusy={widenBusy}
                    onWiden={widen}
                    missingTarget={missingTarget}
                    setMissingTarget={setMissingTarget}
                    missingBusy={missingBusy}
                    onAskMissing={askMissing}
                    missing={missing}
                  />

                {/* 付费缝 (证据态;盖章后消失) */}
                {phase === "evidence" ? (
                  <div className="seg seg-seam seam" ref={seamRef}>
                    <div className="seg-head">
                      <span className="mark">▸ {clock(tape.askedAt + (tape.evidence?.tookMs ?? 0))}</span>
                      <span className="t">{t("ask.seam.title")}</span>
                      <span className="right"><span className="tag warn">{t("ask.seam.badge")}</span></span>
                    </div>
                    <div className="cost">
                      {t("ask.seam.cost")
                        .replace("$0.2–0.5", ASK_THINK_COST_BRACKET)}
                    </div>
                    {seamDismissed ? (
                      <div className="acts">
                        <button type="button" className="btn-paid btn-press" onClick={() => setSeamDismissed(false)}>
                          {t("ask.seam.stamp")}
                          <span className="sub">{t("ask.direct.sub")}</span>
                        </button>
                      </div>
                    ) : (
                      <div className="acts">
                        <button type="button" className="btn-upgrade btn-press" onClick={() => void stamp()}>
                          {t("ask.seam.stamp")}
                        </button>
                        <button type="button" className="btn-no btn-press" onClick={() => setSeamDismissed(true)}>
                          {t("ask.seam.decline")}
                        </button>
                      </div>
                    )}
                    {/* D5-B 槽:若拍板「深答需管理员口令」,盖章前在此缝插口令框——两案同缝 */}
                    <div className="d5"><span className="tag soft">D5</span>{t("ask.seam.d5hook")}</div>
                    {tape.receipt ? (
                      <div className="receipt">
                        {t("ask.seam.receipt")
                          .replace("{t}", formatElapsed(tape.receipt.elapsedMs))
                          .replace("{model}", tape.result?.result?.modelUsed ?? t("ask.model.generic"))}
                      </div>
                    ) : null}
                  </div>
                ) : null}

                {/* 在写段 */}
                {waiting ? (
                  <div className="seg seg-run running">
                    <div className="seg-head">
                      <span className="mark">▸ {clock(tape.runStartedAt ?? tape.askedAt)}</span>
                      <span className="t">{t("ask.seg.run")}</span>
                      <span className="right"><span className="stamp warn">{t("ask.stamp.writing")}</span></span>
                    </div>
                    <div className="tapegrid">
                      <div className="pen" aria-hidden="true" />
                      <div className="clockrow">
                        <div>
                          <div className="wait-clock mono">{formatElapsed(now - (tape.runStartedAt ?? now))}</div>
                          <div className="mono dim9 wt-hint">
                            {(() => {
                              const elapsed = now - (tape.runStartedAt ?? now);
                              const tier = waitTier(elapsed);
                              return tier === 0
                                ? t("ask.wait.hint.normal")
                                : tier === 1
                                  ? t("ask.wait.hint.inrange").replace("{t}", formatElapsed(elapsed))
                                  : t("ask.wait.hint.over").replace("{t}", formatElapsed(elapsed));
                            })()}
                          </div>
                        </div>
                        <div className="hint">{t("ask.wait.note")}</div>
                      </div>
                      <button type="button" className="btn-cancel btn-press" onClick={cut}>
                        {t("ask.wait.cancel")}
                        <span className="sub">{t("ask.wait.cancel.sub")}</span>
                      </button>
                    </div>
                  </div>
                ) : null}

                {/* 答案段 (已成 / 答不出同纸不同章) */}
                {phase === "answer" && tape.result?.result ? (
                  <AnswerSegment
                    tape={tape}
                    noAnswer={!!noAnswer}
                    refs={refs}
                    onJump={jumpToRow}
                    onOpenPage={onOpenPage}
                    gapFocus={gapFocus}
                    onFocusGaps={focusGaps}
                    gapsRef={gapsRef}
                  />
                ) : null}

                {/* 失败段 */}
                {phase === "fail" ? <FailSegment report={tape.result} /> : null}

                {/* 钥匙段 */}
                {phase === "keyless" ? (
                  <div className="seg seg-key">
                    <div className="seg-head">
                      <span className="mark">▸ {clock(Date.now())}</span>
                      <span className="t">{t("ask.seg.key.title")}</span>
                      <span className="right"><span className="stamp warn">{t("ask.stamp.keyless")}</span></span>
                    </div>
                    <div className="keyless">
                      <div className="t">{t("ask.key.title")}</div>
                      <div className="d">{t("ask.key.body")}</div>
                      <div className="mono-note">{t("ask.key.note")}</div>
                      <div className="go">
                        <button type="button" className="linklike" onClick={onOpenAdmin}>
                          {t("ask.key.go")}
                        </button>
                      </div>
                    </div>
                  </div>
                ) : null}

                {/* 会话纸带 (D6-A 槽;新问后旧带归档于此) */}
                {history.length > 0 ? <SessionTapes history={history} embedded /> : null}
              </>
            ) : null}
          </div>
        </div>
      </div>
    </section>
  );
}

// --- empty tape (走带说明 + 本会话的纸带) ------------------------------------------

function EmptyTape({ history }: { history: HistoryEntry[] }) {
  const { t } = useI18n();
  return (
    <div className="sg-empty">
      <div className="tapestart">
        <div className="t">{t("ask.empty.title")}</div>
        <div className="sub">{t("ask.empty.sub")}</div>
      </div>
      <div className="howto">
        <div className="beats">
          <div className="beat"><span className="n">{t("ask.empty.step1.n")}</span><span className="t">{t("ask.empty.beat1")}</span></div>
          <div className="beat"><span className="n">{t("ask.empty.step2.n")}</span><span className="t">{t("ask.empty.beat2")}</span></div>
          <div className="beat paid"><span className="n">{t("ask.empty.step3.n")}</span><span className="t">{t("ask.empty.beat3")}</span></div>
        </div>
        <ul className="promises">
          <li><span className="k">{t("ask.promise.cite.k")}</span><span>{t("ask.promise.cite")}</span></li>
          <li><span className="k">{t("ask.promise.honest.k")}</span><span>{t("ask.promise.honest")}</span></li>
          <li><span className="k">{t("ask.promise.river.k")}</span><span>{t("ask.promise.river")}</span></li>
        </ul>
        <details className="tour">
          <summary>{t("ask.tour.summary")}</summary>
          <div className="body">
            <div>{t("ask.tour.1")}</div>
            <div>{t("ask.tour.2")}</div>
            <div>{t("ask.tour.3")}</div>
            <div>{t("ask.tour.4")}</div>
            <div>{t("ask.tour.5")}</div>
          </div>
        </details>
      </div>
      <SessionTapes history={history} />
    </div>
  );
}

function SessionTapes({ history, embedded = false }: { history: HistoryEntry[]; embedded?: boolean }) {
  const { t } = useI18n();
  const body = (
    <div className="tapes-box">
      <div className="cap">
        <b>{t("ask.history.title")}</b>
        <span className="note">{t("ask.history.note")}</span>
      </div>
      <ul>
        {history.map((h, i) => (
          <li key={i}>
            <span>{h.question}</span>
            <span className="meta2">
              {t(`ask.stamp.${h.stamp}` as MessageKey)} · {h.seconds}s
            </span>
          </li>
        ))}
      </ul>
      <div className="d6"><span className="tag warn">D6</span>{t("ask.history.d6hook")}</div>
    </div>
  );
  if (embedded) {
    return (
      <details className="seg sess embedded">
        <summary>{t("ask.history.title")} · {history.length}</summary>
        {body}
      </details>
    );
  }
  return <div className="sess">{body}</div>;
}

// --- evidence segment ---------------------------------------------------------------

function EvidenceSegment({
  tape,
  noAnswer,
  expanded,
  onToggle,
  registerRow,
  refs,
  widened,
  onOpenPage,
  widenBusy,
  onWiden,
  missingTarget,
  setMissingTarget,
  missingBusy,
  onAskMissing,
  missing,
}: {
  tape: Tape;
  noAnswer: boolean;
  expanded: Set<string>;
  onToggle: (slug: string) => void;
  registerRow: (slug: string, el: HTMLDivElement | null) => void;
  refs: Map<string, ChipRef>;
  widened: Map<string, string>;
  onOpenPage: (ref: PageRef) => void;
  widenBusy: boolean;
  onWiden: () => void;
  missingTarget: string;
  setMissingTarget: (v: string) => void;
  missingBusy: boolean;
  onAskMissing: () => void;
  missing: AskMissingReport | null;
}) {
  const { t } = useI18n();
  const evidence = tape.evidence;

  if (noAnswer) {
    // 答不出变体:免费腿无可出;「确实有什么」= think 自读页的存根(仅 slug+序,无摘录)
    const result = tape.result?.result;
    return (
      <div className="seg seg-ev">
        <div className="seg-head">
          <span className="mark">▸ {clock(tape.askedAt)}</span>
          <span className="t">{t("ask.seg.evidence")}</span>
          <span className="right mono dim10">{t("ask.no.evidence.meta")}</span>
        </div>
        <div className="selfline">{t("ask.no.evidence.self")}</div>
        {(result?.citations ?? []).map((c) => (
          <div className="log" key={c.page_slug}>
            <div className="l1">
              <button
                type="button"
                className="linklike slug"
                title={t("ask.chip.brain.go")}
                onClick={() =>
                  onOpenPage({ slug: c.page_slug, ...(c.source_id !== undefined ? { sourceId: c.source_id } : {}) })
                }
              >
                {c.page_slug}
              </button>
              <span className="type">{t("ask.cites.brain")}</span>
              {c.citation_index !== undefined ? <span className="citebadge">{c.citation_index}</span> : null}
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (evidence === null) {
    return (
      <div className="seg seg-ev">
        <div className="seg-head">
          <span className="mark">▸ {clock(tape.askedAt)}</span>
          <span className="t">{t("ask.seg.evidence")}</span>
        </div>
        <div className="selfline">{t("ask.ev.loading")}</div>
      </div>
    );
  }

  const sources = [...new Set(evidence.rows.map((r) => r.source_id).filter((s): s is string => s !== undefined))];
  const meta = evidence.status === "ok"
    ? t("ask.seg.evidence.meta")
        .replace("{n}", String(evidence.rows.length))
        .replace("{secs}", formatSeconds(evidence.tookMs))
        .replace("{source}", sources.join(" · ") || "—")
    : t("ask.ev.down");

  return (
    <div className="seg seg-ev">
      <div className="seg-head">
        <span className="mark">▸ {clock(tape.askedAt)}</span>
        <span className="t">{t("ask.seg.evidence")}</span>
        <span className="right mono dim10">{meta}</span>
      </div>
      <div className="selfline">{t("ask.seg.evidence.self")}</div>
      {evidence.status !== "ok" ? (
        <div className="ev-error mono">{evidence.error ?? ""}</div>
      ) : null}
      {evidence.rows.map((row) => {
        const isExpanded = expanded.has(row.slug) || widened.has(row.slug);
        const excerpt = widened.get(row.slug) ?? row.chunk_text ?? "";
        const parts = splitExcerpt(excerpt);
        const ref = refs.get(row.slug);
        return (
          <div
            className={`log ${ref?.index !== null && ref?.index !== undefined ? "cited" : ""}`}
            key={`${row.source_id ?? ""}/${row.slug}`}
            ref={(el) => registerRow(row.slug, el)}
          >
            <div className="l1">
              {row.score !== undefined ? (
                <span className="meter">
                  <span className="track"><i style={{ width: `${Math.round(row.score * 100)}%` }} /></span>
                  <span className="n">{row.score.toFixed(3)}</span>
                </span>
              ) : null}
              <span className="slug">{row.slug}</span>
              {row.type !== undefined ? <span className="type">{typeLabel(t, row.type)}</span> : null}
              {row.effective_date !== undefined ? (
                <span className="date" title={row.effective_date}>{shortDate(row.effective_date)}</span>
              ) : null}
              {row.status !== undefined ? <span className="trust">{t("ask.ev.archived")} · </span> : null}
              {row.trust_tier !== undefined ? (
                <span className="trust">{trustLabel(t, row.trust_tier)}</span>
              ) : null}
              {widened.has(row.slug) ? <span className="type">{t("ask.ev.widened")}</span> : null}
              {ref?.index !== null && ref?.index !== undefined ? (
                <span className="citebadge">{ref.index}</span>
              ) : null}
            </div>
            <div className="title">{evidenceTitle(row.title)}</div>
            {parts.body ? (
              <div className={`xc ${isExpanded ? "" : "clamp"}`}>
                {parts.cap ? <span className="xc-cap">{parts.cap}</span> : null}
                {parts.body}
              </div>
            ) : null}
            {parts.body && !widened.has(row.slug) ? (
              <button type="button" className="more" onClick={() => onToggle(row.slug)}>
                {isExpanded ? t("ask.ev.collapse") : t("ask.ev.expand")}
              </button>
            ) : null}
          </div>
        );
      })}
      {/* 桌脚三件:加宽 / 查缺页 / top-K 事实句 */}
      <div className="desk-foot">
        <button type="button" disabled={widenBusy || evidence.rows.length === 0} onClick={onWiden}>
          {widenBusy ? t("ask.foot.widen.busy") : t("ask.foot.widen")}
        </button>
        <span className="missing">
          <input
            className="mono"
            value={missingTarget}
            placeholder={t("ask.foot.missing.placeholder")}
            maxLength={200}
            onChange={(e) => setMissingTarget(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") onAskMissing();
            }}
          />
          <button type="button" disabled={missingBusy || !missingTarget.trim()} onClick={onAskMissing}>
            {t("ask.foot.missing")}
          </button>
        </span>
        <span>
          {t("ask.foot.topk")
            .replace("{n}", String(evidence.rows.length))
            .replace("{pages}", String(tape.result?.result?.pagesGathered ?? "—"))}
        </span>
      </div>
      {missing ? (
        <div className={`missing-report mono ${missing.status}`}>
          <span className="k">{missing.target}</span>
          {missing.status !== "ok" ? (
            <span>{missing.error ?? t("ask.foot.missing.empty")}</span>
          ) : missing.lines.length === 0 ? (
            <span>{t("ask.foot.missing.empty")}</span>
          ) : (
            missing.lines.map((line, i) => <div key={i}>{line}</div>)
          )}
        </div>
      ) : null}
    </div>
  );
}

// --- answer segment ------------------------------------------------------------------

function AnswerSegment({
  tape,
  noAnswer,
  refs,
  onJump,
  onOpenPage,
  gapFocus,
  onFocusGaps,
  gapsRef,
}: {
  tape: Tape;
  noAnswer: boolean;
  refs: Map<string, ChipRef>;
  onJump: (slug: string) => void;
  onOpenPage: (ref: PageRef) => void;
  gapFocus: boolean;
  onFocusGaps: () => void;
  gapsRef: React.MutableRefObject<HTMLDivElement | null>;
}) {
  const { t } = useI18n();
  const result = tape.result!.result!;
  const rows = tape.evidence?.rows ?? [];
  const took = tape.result?.tookMs;
  const inTok = result.usage?.input_tokens?.toLocaleString("en-US");
  const outTok = result.usage?.output_tokens?.toLocaleString("en-US");
  const diag = result.diagnostics as
    | { pagesFromHybrid?: number; takesFromKeyword?: number; takesFromVector?: number }
    | undefined;
  const shared = {
    refs,
    rows,
    pagesGathered: result.pagesGathered,
    onJump,
    onOpenPage,
  };
  return (
    <div className="seg seg-brief">
      <div className="seg-head">
        <span className="mark">▸ {clock(Date.now())}</span>
        <span className="t">{t("ask.seg.answer")}</span>
        <span className="right">
          {result.gaps.length > 0 ? (
            <button type="button" className="gap-link mono" onClick={onFocusGaps}>
              {t("ask.gaps.title")} {result.gaps.length} ↓
            </button>
          ) : null}{" "}
          <span className={`stamp ${noAnswer ? "stop" : "ok"}`}>
            {noAnswer ? t("ask.stamp.notanswered") : t("ask.stamp.answered")}
          </span>
        </span>
      </div>
      <div className="brief">
        <div className="mast">
          <div className="q">{tape.question}</div>
          <span className="mono dim10">
            {took !== undefined ? `${formatSeconds(took)}s · ` : ""}
            {result.pagesGathered !== undefined ? `${result.pagesGathered} ${t("ask.pages")}` : ""}
          </span>
        </div>
        {noAnswer ? <div className="noanswer-lede">{t("ask.no.lede")}</div> : null}
        <AnswerProse markdown={result.answer} {...shared} />

        {/* 缺口块 (D2):原文照录,chip 化引用;聚焦=滚动+琥珀框,章不换字 */}
        {result.gaps.length > 0 ? (
          <div className={`gaps ${gapFocus ? "focus" : ""}`} ref={gapsRef}>
            <div className="head">
              <span className="t">{t("ask.gaps.title")}</span>
              <span className="count">{t("ask.gaps.count").replace("{n}", String(result.gaps.length))}</span>
              <span className="tag">{t("ask.gaps.badge")}</span>
            </div>
            <div className="sub">{t("ask.gaps.sub")}</div>
            <ol>
              {result.gaps.map((gap, i) => (
                <li key={i}>
                  <TextWithChips text={gap} {...shared} />
                </li>
              ))}
            </ol>
          </div>
        ) : null}

        {/* 资料附录:按引用序全列;row_num 全空(非空时锚判定摞,v1 只留钩子文案) */}
        <div className="cites">
          <div className="cap">{t("ask.cites.cap")}</div>
          <ol>
            {result.citations.map((c) => {
              const kind = refs.get(c.page_slug)?.kind ?? "brain";
              return (
                <li key={c.citation_index}>
                  <span className="ix">{c.citation_index}</span>
                  <span className="slug">{c.page_slug}</span>
                  <span className={`kind ${kind === "tape" ? "" : "brain"}`}>
                    {kind === "tape" ? t("ask.cites.desk") : kind === "brain" ? t("ask.cites.brain") : t("ask.cites.gapOnly")}
                  </span>
                  <span className="note">
                    {kind === "brain" || kind === "gap"
                      ? t("ask.cites.brainNote").replace("{n}", String(result.pagesGathered ?? "—"))
                      : ""}
                  </span>
                </li>
              );
            })}
          </ol>
        </div>

        <div className="colophon">
          {t("ask.colophon")
            .replace("{model}", result.modelUsed ?? t("ask.model.generic"))
            .replace("{pages}", String(result.pagesGathered ?? "—"))
            .replace("{takes}", String(result.takesGathered ?? "—"))
            .replace("{h}", String(diag?.pagesFromHybrid ?? result.pagesGathered ?? "—"))
            .replace("{t}", String((diag?.takesFromKeyword ?? 0) + (diag?.takesFromVector ?? 0)))
            .replace("{g}", String(result.graphHits ?? 0))
            .replace("{in}", inTok ?? "—")
            .replace("{out}", outTok ?? "—")}
          <br />
          {t("ask.colophon.time")
            .replace("{s}", took !== undefined ? formatSeconds(took) : "—")}
          {" · "}
          <span className="d6">{t("ask.colophon.d6")}</span>
        </div>
      </div>
    </div>
  );
}

// --- failure segment -------------------------------------------------------------------

function FailSegment({ report }: { report: AskThinkReport | null }) {
  const { t } = useI18n();
  const env = (report?.envelope ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const code = str(env.code) || str(env.error) || "error";
  const docsCmd = Array.isArray(env.docs_cmd)
    ? env.docs_cmd.filter((s): s is string => typeof s === "string").join(" ")
    : "";
  return (
    <div className="seg seg-fail">
      <div className="seg-head">
        <span className="mark">▸ {clock(Date.now())}</span>
        <span className="t">{t("ask.seg.fail")}</span>
        <span className="right"><span className="stamp stop">{t("ask.stamp.failed")}</span></span>
      </div>
      <div className="fail-env">
        <div className="row"><span className="k">{t("ask.fail.code")}</span><span><span className="code">{code}</span></span></div>
        {str(env.message) ? (
          <div className="row"><span className="k">{t("ask.fail.message")}</span><span>{str(env.message)}</span></div>
        ) : null}
        {str(env.suggestion) ? (
          <div className="row"><span className="k">{t("ask.fail.suggestion")}</span><span className="mono">{str(env.suggestion)}</span></div>
        ) : null}
        <div className="row">
          <span className="k">{t("ask.fail.class")}</span>
          <span>{t("ask.fail.caller").replace("{r}", String(env.retryable ?? "?"))}</span>
        </div>
      </div>
      {docsCmd ? (
        <div className="fail-cmd">
          <CopyCommand command={docsCmd} hint={t("ask.fail.cmd.cap")} />
        </div>
      ) : null}
      <div className="fail-note">
        {t("ask.fail.note")}
        {report?.error && !str(env.message) ? <span className="mono"> · {report.error}</span> : null}
      </div>
    </div>
  );
}
