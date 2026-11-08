import { useEffect } from "react";
import { useI18n } from "../lib/i18n";
import { relationCount, usePageBundle, type PageRef } from "../lib/pages";
import { firstLine } from "../lib/text";
import { PageBody } from "./PageBody";
import { Tag } from "./Tag";

// PageDrawer — the shared read-only page view every panel opens IN PLACE
// (Inbox queue-card targets, Search hits; the Nebula drawer shares the same
// fetch hook). Clicking a page reference never leaves the panel: the working
// context (queue tab, pagination, selection, results) stays in front of you,
// Esc/✕ closes, and "edit in Pages →" is the only deliberate jump — the
// write channel lives in the Pages editor, never here.

export function PageDrawer({
  page,
  onClose,
  onEdit,
  onShowGraph,
  /** other same-slug pages found in other sources (bare-slug disambiguation) */
  siblings,
  onOpenSibling,
}: {
  page: PageRef | null;
  onClose: () => void;
  /** "edit in Pages →" — the panel's own openPage (a deliberate jump) */
  onEdit?: (ref: PageRef) => void;
  /** "see on the graph" — the cross-panel reverse edge into Nebula */
  onShowGraph?: (ref: PageRef) => void;
  /**
   * Sibling pages sharing this slug in OTHER sources, when known. Upstream
   * resolves a bare slug SILENTLY (source_id ASC LIMIT 1) — cockpit converts
   * that silent pick into a visible, clickable disambiguation.
   */
  siblings?: PageRef[];
  onOpenSibling?: (ref: PageRef) => void;
}) {
  const { t } = useI18n();
  // full bundle: tags + relation counts ride the same fetch (V1.1 light rows)
  const { bundle, error, loading } = usePageBundle(page, { full: true });

  // Esc closes — same key contract as the Nebula drawer
  useEffect(() => {
    if (!page) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [page, onClose]);

  if (!page) return null;
  const slug = page.slug;
  const shown = bundle?.page;
  // the page the server actually resolved (its source wins over the ref's)
  const sourceId = shown?.source_id ?? page.sourceId;

  return (
    // sticky zero-size anchor: panels scroll the whole stage (unlike
    // Nebula's fixed-height graph wrap), so the drawer rides the stage
    // viewport's top-right for as long as its panel is on screen
    <div className="drawer-anchor">
      <div className="drawer page-drawer" role="dialog" aria-label={t("viewer.caption")}>
        <button
          type="button"
          className="close"
          aria-label={t("common.close")}
          onClick={onClose}
        >
          ✕
        </button>
        <p className="cap">{t("viewer.caption")}</p>
        <h5>{String(shown?.title ?? slug)}</h5>
        {(shown?.title ?? "") !== slug && (
          <div className="kv">
            <span>{t("viewer.slug")}</span>
            <span className="mono">{slug}</span>
          </div>
        )}
        {bundle && (
          <>
            {sourceId !== undefined && (
              <div className="kv">
                <span>{t("viewer.source")}</span>
                <span className="mono">{sourceId}</span>
              </div>
            )}
            <div className="kv">
              <span>{t("viewer.type")}</span>
              <span className="mono">{String(shown?.type ?? "?")}</span>
            </div>
            {typeof shown?.updated_at === "string" && shown.updated_at && (
              <div className="kv">
                <span>{t("pages.updated")}</span>
                <span className="mono">{shown.updated_at.slice(0, 10)}</span>
              </div>
            )}
            {shown?.trust_tier !== undefined && (
              <div className="kv">
                <span>{t("pages.trust")}</span>
                <span className="mono">{String(shown.trust_tier)}</span>
              </div>
            )}
            {shown?.revision !== undefined && (
              <div className="kv">
                <span>{t("pages.revision")}</span>
                <span className="mono">{String(shown.revision)}</span>
              </div>
            )}
            <div className="kv">
              <span>{t("pages.versions")}</span>
              <span className="mono">{String(bundle.versions.length)}</span>
            </div>
            {Array.isArray(shown?.tags) && shown.tags.length > 0 && (
              <div className="kv kv-tags">
                <span>{t("pages.tags")}</span>
                <span className="tag-set">
                  {shown.tags.map((tag) => (
                    <Tag key={String(tag)} variant="term">
                      {String(tag)}
                    </Tag>
                  ))}
                </span>
              </div>
            )}
            {(bundle.links !== undefined || bundle.backlinks !== undefined) && (
              <div className="kv">
                <span>{t("viewer.links")}</span>
                <span className="mono">
                  {t("viewer.outLinks")} {relationCount(bundle.links, "out")} ·{" "}
                  {t("viewer.backlinks")} {relationCount(bundle.backlinks, "in")}
                </span>
              </div>
            )}
          </>
        )}
        {siblings && siblings.length > 0 && onOpenSibling && (
          // the same-slug siblings: a bare slug is one of several pages —
          // say so and offer the jump instead of resolving silently
          <div className="sibling-note">
            <span>{t("viewer.sameSlug")}</span>
            {siblings.map((s) => (
              <button
                key={s.sourceId ?? s.slug}
                type="button"
                className="linkish mono"
                onClick={() => onOpenSibling(s)}
              >
                {s.sourceId ?? "?"}
              </button>
            ))}
          </div>
        )}
        <div className="drawer-body">
          <p className="cap">{t("viewer.body")}</p>
          {loading && <p className="muted small">{t("common.loading")}</p>}
          {error && (
            <p className="error small">
              {t("viewer.loadError")} — {firstLine(error)}
            </p>
          )}
          {/* page bodies are markdown + persistent untrusted input: they
              render through the marked → DOMPurify pipeline only (PageBody) */}
          {shown && !loading && (
            <PageBody className="drawer-content" content={shown.content ?? ""} />
          )}
        </div>
        {(onEdit || onShowGraph) && (
          <div className="drawer-actions">
            {onEdit && (
              <button
                type="button"
                className="linkish"
                onClick={() => onEdit(page)}
              >
                {t("viewer.edit")}
              </button>
            )}
            {onShowGraph && (
              <button
                type="button"
                className="linkish"
                onClick={() => onShowGraph(page)}
              >
                {t("viewer.graph")}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
