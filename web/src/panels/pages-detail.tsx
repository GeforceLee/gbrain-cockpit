import { useCallback, useState, type SyntheticEvent } from "react";
import type {
  LinkRow,
  PageVersion,
  TimelineEntry,
  WriteConflictsReport,
  WriteRequestsReport,
} from "@gbrain-cockpit/shared";
import { ApiError, apiGet } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { relationCount, type PageRef } from "../lib/pages";
import { firstLine, plainExcerpt } from "../lib/text";
import { edgeTypeColor } from "../design/tokens";

// V1.1 dimensions & provenance — the detail-side sections the Pages panel
// composes under its kv block. Each section carries a one-line
// self-description, renders defensively against loose upstream shapes
// (probed 0.60.558; see internal/probes/mcp-probe-v1.1*.json), and treats a
// degraded/missing section as "unavailable", never as an error.

/** One relation GROUP: the same target/referrer page, however many raw
 *  provenance rows upstream reported for it (the same pair arrives once per
 *  link_source — markdown AND mcp-remote-mention — probed 0.60.558). One
 *  row per relation, provenance chips side by side. */
interface RelationGroup {
  ref: PageRef;
  types: Map<string, number>;
  sources: Map<string, number>;
  /** first excerpt represents the group (same pair ⇒ same context text) */
  context: string | null;
}

function groupRelations(
  rows: LinkRow[],
  direction: "out" | "in",
): RelationGroup[] {
  const byKey = new Map<string, RelationGroup>();
  for (const row of rows) {
    const slug = direction === "out" ? row.to_slug : row.from_slug;
    if (typeof slug !== "string" || !slug) continue;
    const sourceId =
      direction === "out" ? row.to_source_id : row.from_source_id;
    const key = `${sourceId ?? ""}/${slug}`;
    let g = byKey.get(key);
    if (!g) {
      g = {
        ref: {
          slug,
          ...(typeof sourceId === "string" && sourceId ? { sourceId } : {}),
        },
        types: new Map(),
        sources: new Map(),
        context: null,
      };
      byKey.set(key, g);
    }
    const type =
      typeof row.link_type === "string" && row.link_type ? row.link_type : "?";
    g.types.set(type, (g.types.get(type) ?? 0) + 1);
    const src =
      typeof row.link_source === "string" && row.link_source
        ? row.link_source
        : "?";
    g.sources.set(src, (g.sources.get(src) ?? 0) + 1);
    if (g.context === null && typeof row.context === "string" && row.context) {
      g.context = row.context;
    }
  }
  return [...byKey.values()];
}

function LinkList({
  direction,
  rows,
  onOpenPage,
}: {
  direction: "out" | "in";
  rows: LinkRow[];
  onOpenPage: (ref: PageRef) => void;
}) {
  const { t } = useI18n();
  const groups = groupRelations(rows, direction);
  if (groups.length === 0) {
    return <p className="muted small">{t("pages.noLinks")}</p>;
  }
  return (
    <ul className="link-list">
      {groups.map((g) => {
        // untrusted context: markdown stripped to plain text, one line
        const context = g.context
          ? plainExcerpt(firstLine(g.context)).slice(0, 140)
          : null;
        return (
          <li key={`${g.ref.sourceId ?? ""}/${g.ref.slug}`}>
            <button
              type="button"
              className="link-row"
              title={context ?? undefined}
              onClick={() => onOpenPage(g.ref)}
            >
              <span className="dir">{direction === "out" ? "→" : "←"}</span>
              <span className="mono link-slug">{g.ref.slug}</span>
              <span className="link-chips">
                {[...g.types.entries()].map(([type, n]) => (
                  <span
                    key={type}
                    className="tag link-type"
                    style={{
                      borderColor: edgeTypeColor(type),
                      color: edgeTypeColor(type),
                    }}
                  >
                    {type}
                    {n > 1 ? ` ×${n}` : ""}
                  </span>
                ))}
                {[...g.sources.entries()].map(([src, n]) => (
                  <span
                    key={src}
                    className="provenance-chip mono"
                    title={t("pages.linkSource")}
                  >
                    {src}
                    {n > 1 ? `×${n}` : ""}
                  </span>
                ))}
              </span>
              <span className="link-src mono">{g.ref.sourceId ?? ""}</span>
            </button>
            {context && <p className="link-context">{context}</p>}
          </li>
        );
      })}
    </ul>
  );
}

/** 关系 — outgoing (get_links) + incoming (get_backlinks) with per-edge
 *  provenance. Same from→to may appear once per link_source; that is the
 *  data, rows render as-is. */
export function PageRelations({
  links,
  backlinks,
  degraded,
  onOpenPage,
}: {
  links?: LinkRow[];
  backlinks?: LinkRow[];
  degraded?: string[];
  onOpenPage: (ref: PageRef) => void;
}) {
  const { t } = useI18n();
  const linksDown = degraded?.includes("links") ?? false;
  const backlinksDown = degraded?.includes("backlinks") ?? false;
  return (
    <details className="detail-block" open>
      <summary>
        {t("pages.relations")} ·{" "}
        <span className="muted">{t("pages.relationsDesc")}</span>
      </summary>
      {/* full-width stacked lists — the earlier 正向|反向 side-by-side split
          starved rows next to unbreakable chips and long federated source
          ids, pushing content off-screen; stacked rows ellipsize instead */}
      <div className="rel-stack">
        <div>
          <p className="cap">
            {t("pages.outLinks")} · {relationCount(links, "out")}
          </p>
          {linksDown ? (
            <p className="muted small">{t("pages.sectionDegraded")}</p>
          ) : (
            <LinkList direction="out" rows={links ?? []} onOpenPage={onOpenPage} />
          )}
        </div>
        <div>
          <p className="cap">
            {t("pages.backlinks")} · {relationCount(backlinks, "in")}
          </p>
          {backlinksDown ? (
            <p className="muted small">{t("pages.sectionDegraded")}</p>
          ) : (
            <>
              <LinkList direction="in" rows={backlinks ?? []} onOpenPage={onOpenPage} />
              {(backlinks?.length ?? 0) >= 500 && (
                <p className="muted small">{t("pages.linksCapNote")}</p>
              )}
            </>
          )}
        </div>
      </div>
    </details>
  );
}

/** 时间线 — read-only dated entries (add_timeline_entry is a write and stays
 *  out of cockpit per the channel matrix; edits go through page editing). */
export function PageTimelineSection({
  timeline,
  degraded,
}: {
  timeline?: TimelineEntry[];
  degraded?: string[];
}) {
  const { t } = useI18n();
  const down = degraded?.includes("timeline") ?? false;
  const entries = timeline ?? [];
  return (
    <details className="detail-block">
      <summary>
        {t("pages.timeline")} · <span className="muted">{t("pages.timelineDesc")}</span>
      </summary>
      {down ? (
        <p className="muted small">{t("pages.sectionDegraded")}</p>
      ) : entries.length === 0 ? (
        <p className="muted small">{t("pages.timelineEmpty")}</p>
      ) : (
        <ul className="timeline-list">
          {entries.map((e, i) => {
            const date = typeof e.date === "string" ? e.date : "";
            const text =
              typeof e.text === "string"
                ? e.text
                : // loose shape (this brain's pages carry none yet — probed
                  // empty): show whatever string fields arrived, defensively
                  Object.entries(e)
                    .filter(([k, v]) => k !== "date" && typeof v === "string")
                    .map(([, v]) => String(v))
                    .join(" · ");
            return (
              <li key={i}>
                {date && <span className="mono tl-date">{date}</span>}
                <span className="tl-text">{text || "—"}</span>
              </li>
            );
          })}
        </ul>
      )}
    </details>
  );
}

/** 历史版本 — metadata-only snapshots (get_versions), newest first. */
export function PageVersionsSection({ versions }: { versions: PageVersion[] }) {
  const { t } = useI18n();
  return (
    <details className="detail-block">
      <summary>
        {t("pages.history")} · {versions.length} ·{" "}
        <span className="muted">{t("pages.historyDesc")}</span>
      </summary>
      {versions.length === 0 ? (
        <p className="muted small">{t("pages.historyEmpty")}</p>
      ) : (
        <ul className="history-list">
          {versions.slice(0, 20).map((v, i) => (
            <li key={String(v.id ?? i)} className="mono small">
              <span className="tl-date">
                {typeof v.snapshot_at === "string" ? v.snapshot_at.slice(0, 19) : "?"}
              </span>
              <span className="tl-text">
                {String(v.title ?? v.type ?? v.id ?? "—")}
              </span>
            </li>
          ))}
        </ul>
      )}
    </details>
  );
}

/** Receipt status → tag variant (same vocabulary as the save receipt slot). */
function receiptTagClass(status: string | undefined): string {
  switch (status) {
    case "committed":
      return "ok";
    case "conflict":
    case "failed":
      return "warn";
    case "cancelled":
      return "plain";
    default:
      return "soft";
  }
}

/** 写收据 — gbrain-side truth for THIS token's writes (list_write_requests)
 *  plus the repeatedly-conflicting pages (list_write_conflicts). Lazy: the
 *  section fetches on first expand and on refresh only — never on panel
 *  mount (rate-budget discipline). */
export function WriteReceiptsSection({
  sourceId,
  readOnly,
  onOpenPage,
}: {
  /** the list view's source filter, when one is picked */
  sourceId?: string;
  /** read-grant profile: receipts are this token's own writes — a read-only
   *  token has none and gbrain refuses the listing, so say that instead */
  readOnly?: boolean;
  onOpenPage: (ref: PageRef) => void;
}) {
  const { t } = useI18n();
  const [requests, setRequests] = useState<WriteRequestsReport | null>(null);
  const [conflicts, setConflicts] = useState<WriteConflictsReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const fetchAll = useCallback(async () => {
    setBusy(true);
    setError(null);
    const suffix = sourceId ? `?source_id=${encodeURIComponent(sourceId)}` : "";
    try {
      const [req, conf] = await Promise.all([
        apiGet<WriteRequestsReport>(`/api/write-requests${suffix}`),
        apiGet<WriteConflictsReport>(`/api/write-conflicts${suffix}`),
      ]);
      setRequests(req);
      setConflicts(conf);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [sourceId]);

  function onToggle(e: SyntheticEvent<HTMLDetailsElement>) {
    if (
      e.currentTarget.open &&
      !readOnly &&
      !requests &&
      !conflicts &&
      !busy &&
      !error
    ) {
      void fetchAll();
    }
  }

  const reqItems = requests?.items ?? [];
  const confItems = conflicts?.items ?? [];
  const unavailable =
    requests?.status !== "ok" || conflicts?.status !== "ok";

  return (
    <details className="detail-block receipts-block" onToggle={onToggle}>
      <summary>
        {t("pages.receipts")} · <span className="muted">{t("pages.receiptsDesc")}</span>
      </summary>
      <div className="receipts-actions">
        {!readOnly && (
          <button type="button" className="linkish" onClick={() => void fetchAll()}>
            {busy ? t("common.loading") : t("pages.receiptsRefresh")}
          </button>
        )}
      </div>
      {readOnly && <p className="muted small">{t("pages.receiptsReadOnly")}</p>}
      {error && (
        <p className="error small">
          {t("common.errorLabel")}: {firstLine(error)}
        </p>
      )}
      {!error && unavailable && requests !== null && (
        <p className="muted small">{t("pages.receiptsUnavailable")}</p>
      )}
      {!error && requests?.status === "ok" && conflicts?.status === "ok" && (
        <>
          {confItems.length > 0 && (
            <div className="conflicts-banner">
              <span className="cap">{t("pages.conflicts")}</span>
              {confItems.map((c, i) => (
                <button
                  key={`${c.slug}-${i}`}
                  type="button"
                  className="linkish mono"
                  onClick={() =>
                    typeof c.slug === "string" &&
                    c.slug &&
                    onOpenPage({
                      slug: c.slug,
                      ...(typeof c.source_id === "string" && c.source_id
                        ? { sourceId: c.source_id }
                        : {}),
                    })
                  }
                >
                  {String(c.slug ?? "?")}
                </button>
              ))}
            </div>
          )}
          {reqItems.length === 0 ? (
            <p className="muted small">{t("pages.receiptsEmpty")}</p>
          ) : (
            <ul className="receipts-list">
              {reqItems.map((r, i) => (
                <li key={String(r.request_id ?? i)} className="mono small">
                  <span className={`tag ${receiptTagClass(r.status)}`}>
                    {String(r.status ?? "?")}
                  </span>
                  <span className="mono">{String(r.request_id ?? "?").slice(0, 8)}</span>
                  {typeof r.slug === "string" && r.slug ? (
                    <button
                      type="button"
                      className="linkish mono"
                      onClick={() =>
                        onOpenPage({
                          slug: r.slug!,
                          ...(typeof r.source_id === "string" && r.source_id
                            ? { sourceId: r.source_id }
                            : {}),
                        })
                      }
                    >
                      {r.slug}
                    </button>
                  ) : null}
                  <span className="muted">
                    {typeof r.created_at === "string" ? r.created_at.slice(0, 19) : ""}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </details>
  );
}
