import { useCallback, useEffect, useState } from "react";
import type { SearchHit, SourcesReport } from "@gbrain-cockpit/shared";
import { PageDrawer } from "../components/PageDrawer";
import { ApiError, apiGet } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { useSlugSiblings, type PageRef } from "../lib/pages";

// Search panel: the cheap hybrid search (no LLM). Results are persistent
// untrusted input — titles/snippets render as plain text, never as markup.
// The shell's global search box (topbar) lands here with a seed query.
// Hits open in the shared in-place drawer — the result list (query, scroll)
// never resets behind you; "edit in Pages →" is the deliberate jump.
//
// Source axis: hits carry their source (same-slug pages in two sources BOTH
// show, distinguishable), and the source filter narrows SERVER-side —
// gbrain's search takes source_id as a pure narrowing param, the grant
// stays the enforcement point (cockpit never assumes a read domain).

export function Search({
  seed,
  onConsumeSeed,
  onOpenPage,
}: {
  seed?: string | null;
  onConsumeSeed?: () => void;
  onOpenPage: (ref: PageRef) => void;
}) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // hit opened in the shared in-place drawer
  const [peek, setPeek] = useState<PageRef | null>(null);
  // source filter: "" = all; options from /api/sources, falling back to the
  // ids observed in hits when the tool is missing (older gbrain)
  const [sourceFilter, setSourceFilter] = useState("");
  const [sources, setSources] = useState<string[] | null>(null);

  const siblings = useSlugSiblings(peek?.slug ?? null, peek?.sourceId);

  useEffect(() => {
    apiGet<SourcesReport>("/api/sources")
      .then((r) => {
        if (r.status === "ok" && r.items) {
          setSources(r.items.map((s) => s.id));
        } else {
          setSources(null); // degraded → observed-only options
        }
      })
      .catch(() => setSources(null));
  }, []);

  const runQuery = useCallback(async (q: string, sourceId: string) => {
    setBusy(true);
    setError(null);
    try {
      const suffix = sourceId ? `&source_id=${encodeURIComponent(sourceId)}` : "";
      setHits(await apiGet<SearchHit[]>(`/api/search?q=${encodeURIComponent(q)}${suffix}`));
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
    void runQuery(seed, "");
    onConsumeSeed?.();
  }, [seed, runQuery, onConsumeSeed]);

  async function run(e: React.FormEvent) {
    e.preventDefault();
    const q = query.trim();
    if (!q) return;
    await runQuery(q, sourceFilter);
  }

  // observed sources from the current hits — the option list when
  // sources_list is unavailable (or before it resolves)
  const observed = new Set(
    (hits ?? []).flatMap((h) => (typeof h.source_id === "string" ? [h.source_id] : [])),
  );
  const sourceOptions = sources ?? [...observed];

  return (
    <section className="panel search-panel">
      {/* FIRST child on purpose (same as Inbox): the sticky anchor must sit
          at the panel top so the drawer lands inside the viewport on open */}
      <PageDrawer
        page={peek}
        onClose={() => setPeek(null)}
        onEdit={onOpenPage}
        siblings={siblings.map((s) => ({ slug: peek!.slug, sourceId: s.source_id }))}
        onOpenSibling={(ref) => setPeek(ref)}
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
        <select
          className="source-filter"
          value={sourceFilter}
          onChange={(e) => setSourceFilter(e.target.value)}
          aria-label={t("search.sourceFilter")}
          title={t("search.sourceScope")}
          disabled={sourceOptions.length === 0}
        >
          <option value="">{t("search.allSources")}</option>
          {sourceOptions.map((id) => (
            <option key={id} value={id}>
              {id}
            </option>
          ))}
        </select>
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
        <p className="muted">{sourceFilter ? t("search.emptySource") : t("search.empty")}</p>
      )}
      <ul className="page-list">
        {(hits ?? []).map((h, i) => (
          <li key={`${h.source_id ?? ""}-${h.slug}-${h.chunk_id ?? i}`}>
            <button
              type="button"
              className="page-row"
              onClick={() =>
                h.slug &&
                setPeek({ slug: h.slug, ...(h.source_id ? { sourceId: h.source_id } : {}) })
              }
            >
              <span className="page-title">{h.title ?? h.slug}</span>
              {h.source_id ? (
                <span className="src-chip mono" title={t("pages.source")}>
                  {h.source_id}
                </span>
              ) : null}
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
