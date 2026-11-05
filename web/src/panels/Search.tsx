import { useCallback, useEffect, useState } from "react";
import type { SearchHit } from "@gbrain-cockpit/shared";
import { PageDrawer } from "../components/PageDrawer";
import { ApiError, apiGet } from "../lib/api";
import { useI18n } from "../lib/i18n";

// Search panel: the cheap hybrid search (no LLM). Results are persistent
// untrusted input — titles/snippets render as plain text, never as markup.
// The shell's global search box (topbar) lands here with a seed query.
// Hits open in the shared in-place drawer — the result list (query, scroll)
// never resets behind you; "edit in Pages →" is the deliberate jump.

export function Search({
  seed,
  onConsumeSeed,
  onOpenPage,
}: {
  seed?: string | null;
  onConsumeSeed?: () => void;
  onOpenPage: (slug: string) => void;
}) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // hit opened in the shared in-place drawer
  const [peekSlug, setPeekSlug] = useState<string | null>(null);

  const runQuery = useCallback(async (q: string) => {
    setBusy(true);
    setError(null);
    try {
      setHits(await apiGet<SearchHit[]>(`/api/search?q=${encodeURIComponent(q)}`));
    } catch (err) {
      setHits(null);
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, []);

  // a seed from the shell's global search box runs immediately, once
  useEffect(() => {
    if (!seed) return;
    setQuery(seed);
    void runQuery(seed);
    onConsumeSeed?.();
  }, [seed, runQuery, onConsumeSeed]);

  async function run(e: React.FormEvent) {
    e.preventDefault();
    const q = query.trim();
    if (!q) return;
    await runQuery(q);
  }

  return (
    <section className="panel search-panel">
      {/* FIRST child on purpose (same as Inbox): the sticky anchor must sit
          at the panel top so the drawer lands inside the viewport on open */}
      <PageDrawer
        slug={peekSlug}
        onClose={() => setPeekSlug(null)}
        onEdit={onOpenPage}
      />
      <h2>{t("panel.search.title")}</h2>
      <p className="panel-desc">{t("panel.search.desc")}</p>
      <form className="search-form" onSubmit={run}>
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("search.placeholder")}
          maxLength={200}
          autoFocus
        />
        <button type="submit" disabled={busy || !query.trim()}>
          {busy ? t("common.loading") : t("search.run")}
        </button>
      </form>
      {error && (
        <p className="error">
          {t("common.errorLabel")}: {error}
        </p>
      )}
      {hits !== null && hits.length === 0 && (
        <p className="muted">{t("search.empty")}</p>
      )}
      <ul className="page-list">
        {(hits ?? []).map((h, i) => (
          <li key={`${h.slug}-${h.chunk_id ?? i}`}>
            <button
              type="button"
              className="page-row"
              onClick={() => h.slug && setPeekSlug(h.slug)}
            >
              <span className="page-title">{h.title ?? h.slug}</span>
              <span className="page-meta mono">
                {h.type ?? "?"} · {h.slug ?? "?"} · {t("search.score")}{" "}
                {h.score?.toFixed(3) ?? "?"}
              </span>
              {h.chunk_text && (
                <span className="page-snippet">{h.chunk_text.slice(0, 220)}</span>
              )}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
