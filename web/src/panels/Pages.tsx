import { useCallback, useEffect, useRef, useState } from "react";
import type {
  PageSummary,
  PagesFacets,
  SourcesReport,
  WriteReceipt,
} from "@gbrain-cockpit/shared";
import { appendAudit, type AuditMeta } from "../lib/auditLog";
import { ApiError, apiGet, apiSend } from "../lib/api";
import { currentProfile } from "../lib/brain";
import { useI18n, type MessageKey } from "../lib/i18n";
import { pageRefQuery, useSlugSiblings, type PageBundle, type PageRef } from "../lib/pages";
import { PageBody } from "../components/PageBody";
import { Pager, usePageSize } from "../components/Pager";
import { Tag } from "../components/Tag";
import {
  PageRelations,
  PageTimelineSection,
  PageVersionsSection,
  WriteReceiptsSection,
} from "./pages-detail";

// Pages panel: list with type facets (enum from gbrain's schema_stats — never
// hardcoded), detail view, and in-place editing on the full receipt protocol
// (expected_revision optimistic lock + request_id idempotency + polling; a
// lost reply is never re-sent with a new id — a 504 keeps the id and polls).
// Page bodies are markdown (verified 2026-11-05) and persistent untrusted
// input: they render through the marked → DOMPurify pipeline only
// (components/PageBody — never raw).
//
// The list paginates through gbrain's OWN keyset cursor (documented by
// list_pages itself): sort=updated_desc + `updated_after` /
// `updated_after_slug` taken from the last row — so every page of a brain is
// reachable, not just the first server-limit window. "Next" past the
// accumulated rows fetches the next chunk; "prev" walks back locally.

type EditorState =
  | { mode: "idle" }
  | { mode: "editing"; draft: string }
  | { mode: "saving" }
  | { mode: "receipt"; receipt: WriteReceipt };

export function Pages({
  focusPage,
  onConsumeFocus,
  onOpenGraph,
}: {
  focusPage: PageRef | null;
  onConsumeFocus: () => void;
  onOpenGraph?: (ref: PageRef) => void;
}) {
  const { t } = useI18n();
  const [facets, setFacets] = useState<PagesFacets | null>(null);
  const [typeFilter, setTypeFilter] = useState<string | null>(null);
  /** rows accumulated so far (paging walks forward through the brain) */
  const [rows, setRows] = useState<PageSummary[] | null>(null);
  /** true while the last fetched batch was full — more pages may exist */
  const [moreAvailable, setMoreAvailable] = useState(false);
  const [fetching, setFetching] = useState(false);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = usePageSize("cockpit.pagesize.pages");
  const [listError, setListError] = useState<string | null>(null);
  const [selected, setSelected] = useState<PageRef | null>(null);
  // source filter: "" = all. Server-side narrowing (list_pages source_id);
  // options from /api/sources with an observed-source fallback.
  const [sourceFilter, setSourceFilter] = useState("");
  const [sources, setSources] = useState<string[] | null>(null);
  // slug/tag dimensions (V1.1): text inputs debounce into server-side
  // params (slug_prefix narrowing + the free-input tag filter — list rows
  // carry no tags upstream, so there is no chip list to enumerate from)
  const [slugInput, setSlugInput] = useState("");
  const [slugFilter, setSlugFilter] = useState("");
  const [tagInput, setTagInput] = useState("");
  const [tagFilter, setTagFilter] = useState("");
  const [bundle, setBundle] = useState<PageBundle | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [editor, setEditor] = useState<EditorState>({ mode: "idle" });
  /** consecutive failed receipt polls for the current pending receipt */
  const pollFailsRef = useRef(0);

  useEffect(() => {
    apiGet<PagesFacets>("/api/pages/facets")
      .then(setFacets)
      .catch(() => setFacets(null));
    apiGet<SourcesReport>("/api/sources")
      .then((r) =>
        setSources(r.status === "ok" && r.items ? r.items.map((x) => x.id) : null),
      )
      .catch(() => setSources(null));
  }, []);

  const fetchRows = useCallback(
    async (offset: number, replace: boolean) => {
      setFetching(true);
      setListError(null);
      try {
        const query = new URLSearchParams({ limit: String(pageSize) });
        // deep paging rides upstream's offset windows — strictly descending,
        // non-overlapping and repeat-stable (probed 0.60.558; the documented
        // keyset pair turned out to act as an ascending "newer-than" filter)
        if (offset > 0) query.set("offset", String(offset));
        if (typeFilter) query.set("type", typeFilter);
        if (sourceFilter) query.set("source_id", sourceFilter);
        if (slugFilter) query.set("slug_prefix", slugFilter);
        if (tagFilter) query.set("tag", tagFilter);
        const batch = await apiGet<PageSummary[]>(`/api/pages?${query}`);
        setRows((prev) => {
          if (replace) return batch;
          // offset windows shouldn't overlap; dedupe stays as the safety net
          // (identity is (source_id, slug) — slug alone swallows twins)
          const seen = new Set((prev ?? []).map((p) => `${p.source_id ?? ""}/${p.slug}`));
          return [
            ...(prev ?? []),
            ...batch.filter((p) => !seen.has(`${p.source_id ?? ""}/${p.slug}`)),
          ];
        });
        setMoreAvailable(batch.length === pageSize);
      } catch (err) {
        if (replace) setRows(null);
        setListError(err instanceof ApiError ? err.message : String(err));
      } finally {
        setFetching(false);
      }
    },
    [typeFilter, sourceFilter, slugFilter, tagFilter, pageSize],
  );

  // filter / page-size changes restart from the first page
  useEffect(() => {
    setPage(0);
    void fetchRows(0, true);
  }, [fetchRows]);

  function goToPage(next: number) {
    if (fetching) return;
    next = Math.max(0, next);
    const start = next * pageSize;
    if (start < (rows?.length ?? 0)) {
      // inside the accumulated window — walk locally
      setPage(next);
      return;
    }
    // beyond it: fetch that offset page directly (blocked at the known end)
    if (!moreAvailable) return;
    setPage(next);
    void fetchRows(start, false);
  }

  const openPage = useCallback(async (ref: PageRef) => {
    setSelected(ref);
    setDetailError(null);
    setBundle(null);
    setEditor({ mode: "idle" });
    try {
      // full=1: the V1.1 provenance sections (relations / timeline) ride the
      // same fetch; the server degrades failed sections in-band
      setBundle(await apiGet<PageBundle>(`/api/page?${pageRefQuery(ref)}&full=1`));
    } catch (err) {
      setDetailError(err instanceof ApiError ? err.message : String(err));
    }
  }, []);

  // text filters debounce into the server-side params — typing never fires a
  // request per keystroke
  useEffect(() => {
    const timer = setTimeout(() => {
      setSlugFilter(slugInput.trim());
      setTagFilter(tagInput.trim());
    }, 400);
    return () => clearTimeout(timer);
  }, [slugInput, tagInput]);

  useEffect(() => {
    if (focusPage) {
      void openPage(focusPage);
      onConsumeFocus();
    }
  }, [focusPage, openPage, onConsumeFocus]);

  // Poll a pending write to final; same request_id, never a new send.
  // A receipt that keeps failing to poll (server unreachable, or the write
  // never reached gbrain) settles as "unknown" after a bounded number of
  // tries instead of spinning forever — the conflict check on any later
  // re-save is the safety net for a lost write.
  useEffect(() => {
    if (editor.mode !== "receipt") return;
    const receipt = editor.receipt;
    if (receipt.status !== "pending" && receipt.status !== "queued" && receipt.status !== "running") {
      return;
    }
    // total deadline: even a healthy-looking endless "queued" must converge
    // to unknown — a deferred write upstream can outlive any patience, and
    // the receipts section is the honest place to check later
    const deadline = Date.now() + 5 * 60_000;
    const timer = setInterval(async () => {
      if (Date.now() > deadline) {
        appendAudit(`page.write ${receipt.request_id} -> POLL-DEADLINE`);
        setEditor({
          mode: "receipt",
          receipt: {
            request_id: receipt.request_id,
            status: "unknown",
            detail: t("pages.pollDeadline"),
          },
        });
        return;
      }
      try {
        const next = await apiGet<WriteReceipt>(
          `/api/write-request?request_id=${encodeURIComponent(receipt.request_id)}`,
        );
        pollFailsRef.current = 0;
        if (next.status !== receipt.status) {
          appendAudit(`page.write ${receipt.request_id} -> ${next.status}`, metaFor(next));
        }
        setEditor({ mode: "receipt", receipt: next });
      } catch {
        pollFailsRef.current += 1;
        if (pollFailsRef.current >= 6) {
          appendAudit(`page.write ${receipt.request_id} -> POLL-LOST`);
          setEditor({
            mode: "receipt",
            receipt: {
              request_id: receipt.request_id,
              status: "unknown",
              detail: "receipt polling failed repeatedly (channel down?)",
            },
          });
        }
        // transient poll failure — keep the slot, try again next tick
      }
    }, 2500);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor]);

  /** structured meta for the Recent-Verdicts table (page writes) */
  function metaFor(receipt: WriteReceipt): AuditMeta {
    const slug = bundle?.page.slug ?? "?";
    if (receipt.status === "committed") {
      return {
        ref: slug,
        label: bundle?.page.title ?? slug,
        verdict: "ok",
        verdictText: t("verdict.written"),
        receipt: receipt.request_id.slice(0, 8),
      };
    }
    if (receipt.status === "conflict" || receipt.status === "failed" || receipt.status === "cancelled") {
      return {
        ref: slug,
        label: bundle?.page.title ?? slug,
        verdict: "warn",
        verdictText: t("verdict.failed"),
        receipt: receipt.request_id.slice(0, 8),
      };
    }
    return {
      ref: slug,
      label: bundle?.page.title ?? slug,
      verdict: "warn",
      verdictText: receipt.status,
      receipt: receipt.request_id.slice(0, 8),
    };
  }

  async function save() {
    if (editor.mode !== "editing" || !bundle) return;
    setEditor({ mode: "saving" });
    const requestId = crypto.randomUUID();
    appendAudit(`page.write ${bundle.page.slug} req=${requestId.slice(0, 8)} -> SENT`);
    try {
      const receipt = await apiSend<WriteReceipt>("/api/page", "PUT", {
        slug: bundle.page.slug,
        content: editor.draft,
        expected_revision: bundle.page.revision,
        request_id: requestId,
      });
      setEditor({ mode: "receipt", receipt });
      appendAudit(`page.write ${requestId} -> ${receipt.status}`, metaFor(receipt));
      if (receipt.status === "committed") {
        // refresh the detail view behind the receipt slot
        const fresh = await apiGet<PageBundle>(
          `/api/page?${pageRefQuery({
            slug: bundle.page.slug,
            ...(bundle.page.source_id ? { sourceId: bundle.page.source_id } : {}),
          })}&full=1`,
        );
        setBundle(fresh);
      }
    } catch (err) {
      const detail = err instanceof ApiError ? err.message : String(err);
      // A 504 means the upstream wait window elapsed — the write may still be
      // sitting in gbrain's queue. Keep the SAME request_id and poll the
      // receipt; never re-send with a fresh id (ARCHITECTURE §3.1). Any other
      // error is a real refusal (validation / auth / rate limit): the request
      // never queued, so a plain failed receipt with the traceable id is
      // honest. A later manual re-save mints a new id and is protected by the
      // expected_revision conflict check either way.
      if (err instanceof ApiError && err.status === 504) {
        appendAudit(`page.write ${requestId} -> TIMEOUT (polling receipt)`);
        pollFailsRef.current = 0;
        setEditor({
          mode: "receipt",
          receipt: { request_id: requestId, status: "pending", detail },
        });
        return;
      }
      appendAudit(`page.write ${requestId} -> ERR`);
      setEditor({
        mode: "receipt",
        receipt: { request_id: requestId, status: "failed", detail },
      });
    }
  }

  const inDetail = selected !== null;
  const slugSiblings = useSlugSiblings(
    inDetail ? (selected?.slug ?? null) : null,
    bundle?.page.source_id ?? selected?.sourceId,
  );

  // pager math: facet counts are the only true totals and they span ALL
  // sources — under source/slug/tag narrowing they overestimate, so the
  // pager there grows dynamically (one page ahead) as batches accumulate
  const narrowed = sourceFilter !== "" || slugFilter !== "" || tagFilter !== "";
  const filterTotal = narrowed
    ? undefined
    : typeFilter
      ? facets?.by_type.find((f) => f.type === typeFilter)?.count
      : facets?.total_pages;
  const rowsCount = rows?.length ?? 0;
  const accumulatedPages = Math.max(1, Math.ceil((rowsCount || 1) / pageSize));
  const totalPages = filterTotal
    ? Math.max(Math.ceil(filterTotal / pageSize), page + 1)
    : moreAvailable
      ? Math.max(accumulatedPages, page + 1) + 1
      : Math.max(accumulatedPages, page + 1);
  const safePage = Math.min(page, totalPages - 1);
  const currentRows = (rows ?? []).slice(
    safePage * pageSize,
    (safePage + 1) * pageSize,
  );

  return (
    <section className="panel pages">
      {!inDetail ? (
        <>
          <h2>{t("panel.pages.title")}</h2>
          <p className="panel-desc">{t("panel.pages.desc")}</p>
          {facets && (
            <div className="chips" role="group" aria-label={t("pages.filterByType")}>
              <button
                type="button"
                className={typeFilter === null ? "chip-btn active" : "chip-btn"}
                onClick={() => setTypeFilter(null)}
              >
                {t("pages.allTypes")} · {facets.total_pages ?? "?"}
              </button>
              {facets.by_type.map((f) => (
                <button
                  key={f.type}
                  type="button"
                  className={typeFilter === f.type ? "chip-btn active" : "chip-btn"}
                  onClick={() => setTypeFilter(f.type)}
                >
                  {f.type} · {f.count}
                </button>
              ))}
            </div>
          )}
          {/* 写收据 — gbrain-side truth, lazy: fetches on first expand only.
              Read-only profiles never fetch: receipts are this token's own
              writes and a read grant has none (gbrain refuses the listing). */}
          <WriteReceiptsSection
            sourceId={sourceFilter || undefined}
            readOnly={currentProfile()?.readOnly === true}
            onOpenPage={(ref) => void openPage(ref)}
          />
          <div className="list-tools">
            <span className="muted">
              {t("pages.listCaption")} · {filterTotal ?? rowsCount}
            </span>
            <input
              type="search"
              className="text-filter mono"
              value={slugInput}
              onChange={(e) => setSlugInput(e.target.value)}
              placeholder={t("pages.slugPlaceholder")}
              aria-label={t("pages.filterBySlug")}
              maxLength={120}
            />
            <input
              type="search"
              className="text-filter"
              value={tagInput}
              onChange={(e) => setTagInput(e.target.value)}
              placeholder={t("pages.tagPlaceholder")}
              aria-label={t("pages.filterByTag")}
              maxLength={64}
            />
            {((sources ?? []).length > 0 || sourceFilter !== "") && (
              <select
                className="source-filter"
                value={sourceFilter}
                onChange={(e) => setSourceFilter(e.target.value)}
                aria-label={t("pages.filterBySource")}
                title={t("pages.sourceScope")}
              >
                <option value="">{t("pages.allSources")}</option>
                {(sources ?? []).map((id) => (
                  <option key={id} value={id}>
                    {id}
                  </option>
                ))}
              </select>
            )}
            {rowsCount > 0 && totalPages > 1 && (
              <Pager
                page={safePage}
                totalPages={totalPages}
                size={pageSize}
                onPage={goToPage}
                onSize={(next) => setPageSize(next)}
              />
            )}
          </div>
          {listError && (
            <p className="error">
              {t("common.errorLabel")}: {listError}
            </p>
          )}
          {!rows && !listError && <p className="muted">{t("common.loading")}</p>}
          {rows && rowsCount === 0 && !listError && (
            <p className="muted">{t("pages.empty")}</p>
          )}
          {fetching && currentRows.length === 0 && (
            <p className="muted">{t("common.loading")}</p>
          )}
          <ul className="page-list">
            {currentRows.map((p) => (
              <li key={`${p.source_id ?? ""}/${p.slug}`}>
                <button
                  type="button"
                  className="page-row"
                  onClick={() =>
                    void openPage({
                      slug: p.slug,
                      ...(p.source_id ? { sourceId: p.source_id } : {}),
                    })
                  }
                >
                  <span className="page-title">{p.title ?? p.slug}</span>
                  {p.source_id ? (
                    <span className="src-chip mono" title={t("pages.source")}>
                      {p.source_id}
                    </span>
                  ) : null}
                  <span className="page-meta mono">
                    {p.type ?? "?"} · {p.slug} · {(p.updated_at ?? "").slice(0, 10)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <>
          <div className="panel-head">
            <div>
              <button type="button" className="linkish" onClick={() => setSelected(null)}>
                ← {t("pages.back")}
              </button>
              <h2 className="mono small">{selected?.slug}</h2>
            </div>
            {selected && onOpenGraph && (
              // the neighborhood a page lives in is a graph question — one
              // click lands Nebula on this node in the orbit view
              <button
                type="button"
                className="linkish"
                onClick={() => onOpenGraph(selected)}
              >
                {t("pages.inGraph")}
              </button>
            )}
            {bundle && editor.mode === "idle" && (
              // Read-grant profile (no write scope): a save could only ever
              // fail upstream — show the reason instead of an impossible
              // button. The server stays the enforcer; UX narrowing only.
              currentProfile()?.readOnly === true ? (
                <span className="readonly-note" title={t("pages.readOnly")}>
                  {t("pages.readOnly")}
                </span>
              ) : (
                <button type="button" onClick={() => setEditor({ mode: "editing", draft: bundle.page.content ?? "" })}>
                  {t("pages.edit")}
                </button>
              )
            )}
          </div>

          {detailError && (
            <p className="error">
              {t("common.errorLabel")}: {detailError}
            </p>
          )}
          {!bundle && !detailError && <p className="muted">{t("common.loading")}</p>}

          {bundle && (
            <>
              <p className="page-title-lg">{bundle.page.title ?? bundle.page.slug}</p>
              <dl className="kv">
                {bundle.page.source_id !== undefined && (
                  <Row label={t("pages.source")} value={bundle.page.source_id} />
                )}
                <Row label={t("pages.type")} value={bundle.page.type ?? "?"} />
                <Row
                  label={t("pages.updated")}
                  value={(bundle.page.updated_at ?? "").replace("T", " ").slice(0, 19)}
                />
                {Array.isArray(bundle.page.tags) && bundle.page.tags.length > 0 && (
                  <div className="kv-row">
                    <dt>{t("pages.tags")}</dt>
                    <dd className="tag-set">
                      {bundle.page.tags.map((tag) => (
                        <Tag key={String(tag)} variant="term">
                          {String(tag)}
                        </Tag>
                      ))}
                    </dd>
                  </div>
                )}
                {typeof bundle.page.origin === "string" && bundle.page.origin && (
                  <Row label={t("pages.origin")} value={bundle.page.origin} />
                )}
                {typeof bundle.page.created_at === "string" && bundle.page.created_at && (
                  <Row
                    label={t("pages.createdAt")}
                    value={bundle.page.created_at.replace("T", " ").slice(0, 19)}
                  />
                )}
                {typeof bundle.page.source_path === "string" && bundle.page.source_path && (
                  <Row label={t("pages.sourceFile")} value={bundle.page.source_path} />
                )}
                {typeof bundle.page.quoted === "string" && bundle.page.quoted && (
                  <Row label={t("pages.quoted")} value={bundle.page.quoted} />
                )}
                {bundle.page.trust_tier !== undefined && (
                  <Row label={t("pages.trust")} value={String(bundle.page.trust_tier)} />
                )}
                <Row
                  label={t("pages.revision")}
                  value={String(bundle.page.revision ?? "?")}
                />
                <Row label={t("pages.versions")} value={String(bundle.versions.length)} />
              </dl>

              {slugSiblings.length > 0 && (
                // same-slug pages exist in other sources: upstream resolved
                // this bare slug SILENTLY — show the split and offer the jump
                <div className="sibling-note">
                  <span>{t("viewer.sameSlug")}</span>
                  {slugSiblings.map((x) => (
                    <button
                      key={x.source_id ?? x.slug}
                      type="button"
                      className="linkish mono"
                      onClick={() =>
                        void openPage({ slug: bundle.page.slug, sourceId: x.source_id })
                      }
                    >
                      {x.source_id ?? "?"}
                    </button>
                  ))}
                </div>
              )}

              {editor.mode === "idle" && (
                <>
                  <PageRelations
                    links={bundle.links}
                    backlinks={bundle.backlinks}
                    degraded={bundle.degraded}
                    onOpenPage={(ref) => void openPage(ref)}
                  />
                  <PageTimelineSection
                    timeline={bundle.timeline}
                    degraded={bundle.degraded}
                  />
                  <PageVersionsSection versions={bundle.versions} />
                  <PageBody
                    className="page-content"
                    content={bundle.page.content ?? ""}
                  />
                </>
              )}

              {editor.mode === "editing" && (
                <div className="editor">
                  <textarea
                    value={editor.draft}
                    onChange={(e) => setEditor({ mode: "editing", draft: e.target.value })}
                    rows={18}
                    spellCheck={false}
                  />
                  <div className="editor-actions">
                    <button type="button" onClick={() => void save()}>
                      {t("pages.save")}
                    </button>
                    <button type="button" onClick={() => setEditor({ mode: "idle" })}>
                      {t("pages.cancel")}
                    </button>
                  </div>
                  <p className="hint">{t("pages.editHint")}</p>
                  {slugSiblings.length > 0 && (
                    <p className="hint">{t("pages.editSameSlug")}</p>
                  )}
                </div>
              )}

              {editor.mode === "saving" && <p className="muted">{t("pages.saving")}</p>}

              {editor.mode === "receipt" && (
                <div className={`receipt receipt-${editor.receipt.status}`}>
                  <p>
                    {t(`receipt.${editor.receipt.status}` as MessageKey)}
                    {editor.receipt.detail ? (
                      <span className="muted"> — {editor.receipt.detail}</span>
                    ) : null}
                  </p>
                  {editor.receipt.status === "conflict" && (
                    <button type="button" onClick={() =>
                      void openPage({
                        slug: bundle.page.slug,
                        ...(bundle.page.source_id
                          ? { sourceId: bundle.page.source_id }
                          : {}),
                      })
                    }>
                      {t("receipt.reloadAfterConflict")}
                    </button>
                  )}
                  {(editor.receipt.status === "committed" ||
                    editor.receipt.status === "failed" ||
                    editor.receipt.status === "cancelled" ||
                    editor.receipt.status === "unknown") && (
                    <button type="button" onClick={() => setEditor({ mode: "idle" })}>
                      {t("common.close")}
                    </button>
                  )}
                </div>
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="kv-row">
      <dt>{label}</dt>
      <dd className="mono">{value}</dd>
    </div>
  );
}
