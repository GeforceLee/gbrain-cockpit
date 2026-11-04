import { useCallback, useEffect, useState } from "react";
import type {
  PageDetail,
  PageSummary,
  PageVersion,
  PagesFacets,
  WriteReceipt,
} from "@gbrain-cockpit/shared";
import { appendAudit, type AuditMeta } from "../lib/auditLog";
import { ApiError, apiGet, apiSend } from "../lib/api";
import { useI18n, type MessageKey } from "../lib/i18n";

// Pages panel: list with type facets (enum from gbrain's schema_stats — never
// hardcoded), detail view, and in-place editing on the full receipt protocol
// (expected_revision optimistic lock + request_id idempotency + polling; a
// lost reply is never re-sent with a new id). Page bodies are persistent
// untrusted input: rendered as plain text only in this milestone — the
// marked → DOMPurify pipeline arrives with rich rendering (V1.1).

interface PageBundle {
  page: PageDetail;
  versions: PageVersion[];
}

type EditorState =
  | { mode: "idle" }
  | { mode: "editing"; draft: string }
  | { mode: "saving" }
  | { mode: "receipt"; receipt: WriteReceipt };

export function Pages({
  focusSlug,
  onConsumeFocus,
}: {
  focusSlug: string | null;
  onConsumeFocus: () => void;
}) {
  const { t } = useI18n();
  const [facets, setFacets] = useState<PagesFacets | null>(null);
  const [typeFilter, setTypeFilter] = useState<string | null>(null);
  const [pages, setPages] = useState<PageSummary[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [bundle, setBundle] = useState<PageBundle | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [editor, setEditor] = useState<EditorState>({ mode: "idle" });

  useEffect(() => {
    apiGet<PagesFacets>("/api/pages/facets")
      .then(setFacets)
      .catch(() => setFacets(null));
  }, []);

  const loadList = useCallback(async () => {
    setListError(null);
    try {
      const query = new URLSearchParams({ limit: "50" });
      if (typeFilter) query.set("type", typeFilter);
      setPages(await apiGet<PageSummary[]>(`/api/pages?${query}`));
    } catch (err) {
      setPages(null);
      setListError(err instanceof ApiError ? err.message : String(err));
    }
  }, [typeFilter]);

  useEffect(() => {
    void loadList();
  }, [loadList]);

  const openPage = useCallback(async (slug: string) => {
    setSelected(slug);
    setDetailError(null);
    setBundle(null);
    setEditor({ mode: "idle" });
    try {
      setBundle(
        await apiGet<PageBundle>(`/api/page?slug=${encodeURIComponent(slug)}`),
      );
    } catch (err) {
      setDetailError(err instanceof ApiError ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    if (focusSlug) {
      void openPage(focusSlug);
      onConsumeFocus();
    }
  }, [focusSlug, openPage, onConsumeFocus]);

  // Poll a pending write to final; same request_id, never a new send.
  useEffect(() => {
    if (editor.mode !== "receipt") return;
    const receipt = editor.receipt;
    if (receipt.status !== "pending" && receipt.status !== "queued" && receipt.status !== "running") {
      return;
    }
    const timer = setInterval(async () => {
      try {
        const next = await apiGet<WriteReceipt>(
          `/api/write-request?request_id=${encodeURIComponent(receipt.request_id)}`,
        );
        if (next.status !== receipt.status) {
          appendAudit(`page.write ${receipt.request_id} -> ${next.status}`, metaFor(next));
        }
        setEditor({ mode: "receipt", receipt: next });
      } catch {
        // transient poll failure — keep the slot, try again next tick
      }
    }, 2500);
    return () => clearInterval(timer);
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
          `/api/page?slug=${encodeURIComponent(bundle.page.slug)}`,
        );
        setBundle(fresh);
      }
    } catch (err) {
      appendAudit(`page.write ${requestId} -> ERR`);
      setEditor({
        mode: "receipt",
        receipt: {
          request_id: "n/a",
          status: "failed",
          detail: err instanceof ApiError ? err.message : String(err),
        },
      });
    }
  }

  const inDetail = selected !== null;

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
          {listError && <p className="error">{listError}</p>}
          {!pages && !listError && <p className="muted">{t("common.loading")}</p>}
          {pages && pages.length === 0 && (
            <p className="muted">{t("pages.empty")}</p>
          )}
          <ul className="page-list">
            {(pages ?? []).map((p) => (
              <li key={p.slug}>
                <button type="button" className="page-row" onClick={() => void openPage(p.slug)}>
                  <span className="page-title">{p.title ?? p.slug}</span>
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
              <h2 className="mono small">{selected}</h2>
            </div>
            {bundle && editor.mode === "idle" && (
              <button type="button" onClick={() => setEditor({ mode: "editing", draft: bundle.page.content ?? "" })}>
                {t("pages.edit")}
              </button>
            )}
          </div>

          {detailError && <p className="error">{detailError}</p>}
          {!bundle && !detailError && <p className="muted">{t("common.loading")}</p>}

          {bundle && (
            <>
              <p className="page-title-lg">{bundle.page.title ?? bundle.page.slug}</p>
              <dl className="kv">
                <Row label={t("pages.type")} value={bundle.page.type ?? "?"} />
                <Row
                  label={t("pages.updated")}
                  value={(bundle.page.updated_at ?? "").replace("T", " ").slice(0, 19)}
                />
                {bundle.page.trust_tier !== undefined && (
                  <Row label={t("pages.trust")} value={String(bundle.page.trust_tier)} />
                )}
                <Row
                  label={t("pages.revision")}
                  value={String(bundle.page.revision ?? "?")}
                />
                <Row label={t("pages.versions")} value={String(bundle.versions.length)} />
              </dl>

              {editor.mode === "idle" && (
                <pre className="page-content">{bundle.page.content ?? ""}</pre>
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
                    <button type="button" onClick={() => void openPage(bundle.page.slug)}>
                      {t("receipt.reloadAfterConflict")}
                    </button>
                  )}
                  {(editor.receipt.status === "committed" ||
                    editor.receipt.status === "failed" ||
                    editor.receipt.status === "cancelled") && (
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
