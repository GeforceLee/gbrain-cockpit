import { useEffect } from "react";
import { useI18n } from "../lib/i18n";
import { usePageBundle } from "../lib/pages";
import { firstLine } from "../lib/text";

// PageDrawer — the shared read-only page view every panel opens IN PLACE
// (Inbox queue-card targets, Search hits; the Nebula drawer shares the same
// fetch hook). Clicking a page reference never leaves the panel: the working
// context (queue tab, pagination, selection, results) stays in front of you,
// Esc/✕ closes, and "edit in Pages →" is the only deliberate jump — the
// write channel lives in the Pages editor, never here.

export function PageDrawer({
  slug,
  onClose,
  onEdit,
}: {
  slug: string | null;
  onClose: () => void;
  /** "edit in Pages →" — the panel's own openPage (a deliberate jump) */
  onEdit?: (slug: string) => void;
}) {
  const { t } = useI18n();
  const { bundle, error, loading } = usePageBundle(slug);

  // Esc closes — same key contract as the Nebula drawer
  useEffect(() => {
    if (!slug) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [slug, onClose]);

  if (!slug) return null;
  const page = bundle?.page;

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
        <h5>{String(page?.title ?? slug)}</h5>
        {(page?.title ?? "") !== slug && (
          <div className="kv">
            <span>{t("viewer.slug")}</span>
            <span className="mono">{slug}</span>
          </div>
        )}
        {bundle && (
          <>
            <div className="kv">
              <span>{t("viewer.type")}</span>
              <span className="mono">{String(page?.type ?? "?")}</span>
            </div>
            {typeof page?.updated_at === "string" && page.updated_at && (
              <div className="kv">
                <span>{t("pages.updated")}</span>
                <span className="mono">{page.updated_at.slice(0, 10)}</span>
              </div>
            )}
            {page?.trust_tier !== undefined && (
              <div className="kv">
                <span>{t("pages.trust")}</span>
                <span className="mono">{String(page.trust_tier)}</span>
              </div>
            )}
            {page?.revision !== undefined && (
              <div className="kv">
                <span>{t("pages.revision")}</span>
                <span className="mono">{String(page.revision)}</span>
              </div>
            )}
            <div className="kv">
              <span>{t("pages.versions")}</span>
              <span className="mono">{String(bundle.versions.length)}</span>
            </div>
          </>
        )}
        <div className="drawer-body">
          <p className="cap">{t("viewer.body")}</p>
          {loading && <p className="muted small">{t("common.loading")}</p>}
          {error && (
            <p className="error small">
              {t("viewer.loadError")} — {firstLine(error)}
            </p>
          )}
          {/* page bodies are persistent untrusted input: plain text via a
              React text node only, never innerHTML (same milestone rule as
              Pages/Nebula; V1.1 swaps to marked → DOMPurify) */}
          {page && !loading && (
            <pre className="drawer-content">{page.content ?? ""}</pre>
          )}
        </div>
        {onEdit && (
          <div className="drawer-actions">
            <button
              type="button"
              className="linkish"
              onClick={() => onEdit(slug)}
            >
              {t("viewer.edit")}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
