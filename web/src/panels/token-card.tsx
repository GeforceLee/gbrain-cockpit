import { useCallback, useEffect, useRef, useState } from "react";
import type {
  TokenIssuedResponse,
  TokenRecord,
  TokensResponse,
} from "@gbrain-cockpit/shared";
import { ApiError, apiGet, apiSend } from "../lib/api";
import { useBrain } from "../lib/brain";
import { commandHash, copyCommandText } from "../lib/clipboard";
import { errorMessage, stepUpErrorMessage } from "../lib/errors";
import { useI18n } from "../lib/i18n";
import { checkTokenName, nameIsTaken } from "../lib/tokenName";

// 访问令牌 · ACCESS TOKENS — the owner's key rack (0.7 named tokens).
// One row per person: name, the brains they may enter, whether they may
// adjudicate, when they last used it. Three actions, all management writes:
// issue, re-grant, revoke.
//
// Discipline:
// - Every write is a step-up: the admin token is pasted per action, rides
//   that one request, and is cleared after it — a failure never leaves it
//   in a panel that stays mounted (a wrong paste keeps the prompt open,
//   with the reason, and only empties the field).
// - The name is checked against the server's rules BEFORE the admin is
//   asked to paste anything.
// - The plaintext token exists in exactly one response: it is shown once,
//   in a dialog only "I saved it" closes, as a <code> node (never an input —
//   password managers and autofill must not capture it), with the keyboard
//   kept inside the dialog while it is open.
// - Revoke is two conscious steps (say it, then paste) and is never undone.
// - Revoked rows fold away under a quiet count instead of stacking up.

interface Sheet {
  name: string;
  brains: string[];
  adjudicate: boolean;
}

type Armed =
  | { kind: "issue"; sheet: Sheet }
  | { kind: "grants"; record: TokenRecord; brains: string[]; adjudicate: boolean }
  | { kind: "revoke"; record: TokenRecord }
  | null;

/** the paste prompt closes itself if left alone */
const STEP_UP_IDLE_MS = 120_000;

/** ISO → the viewer's own clock, to the minute */
function stamp(iso: string | null, locale: string): string {
  if (!iso) return "—";
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "—";
  return at.toLocaleString(locale, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function TokenCard() {
  const { t, locale } = useI18n();
  const brain = useBrain();
  const brainIds = brain.profiles.map((p) => p.id);

  const [rows, setRows] = useState<TokenRecord[] | null>(null);
  const [off, setOff] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  // issue form
  const [formOpen, setFormOpen] = useState(false);
  const [name, setName] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [adjudicate, setAdjudicate] = useState(false);

  // inline re-grant
  const [editing, setEditing] = useState<TokenRecord | null>(null);
  const [editPicked, setEditPicked] = useState<string[]>([]);
  const [editAdjudicate, setEditAdjudicate] = useState(false);

  // step-up
  const [armed, setArmed] = useState<Armed>(null);
  const [adminToken, setAdminToken] = useState("");
  const [sending, setSending] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pasteRef = useRef<HTMLInputElement | null>(null);
  const issueButtonRef = useRef<HTMLButtonElement | null>(null);

  // the one-time plaintext
  const [issued, setIssued] = useState<TokenIssuedResponse | null>(null);
  const [copied, setCopied] = useState<"copied" | "selected" | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);

  const load = useCallback(async () => {
    try {
      const body = await apiGet<TokensResponse>("/api/tokens");
      setRows(body.tokens);
      setOff(false);
      setLoadError(null);
    } catch (err) {
      if (err instanceof ApiError && err.code === "E_NOT_CONFIGURED") {
        setOff(true);
        setRows([]);
        setLoadError(null);
      } else {
        setLoadError(errorMessage(err, t));
      }
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  function clearIdle() {
    if (idleTimer.current) clearTimeout(idleTimer.current);
    idleTimer.current = null;
  }

  function disarm() {
    clearIdle();
    setArmed(null);
    setAdminToken("");
  }

  /** (re)start the idle countdown that closes an unattended prompt */
  function armIdle() {
    clearIdle();
    idleTimer.current = setTimeout(disarm, STEP_UP_IDLE_MS);
  }

  function arm(next: Armed) {
    setActionError(null);
    setAdminToken("");
    setArmed(next);
    armIdle();
  }

  // leaving the card with a pasted admin token in it must not keep it
  useEffect(() => () => disarm(), []);

  // the paste field takes focus when the prompt appears
  useEffect(() => {
    if (armed) pasteRef.current?.focus();
  }, [armed]);

  async function run() {
    if (!armed || !adminToken || sending) return;
    setSending(true);
    setActionError(null);
    try {
      if (armed.kind === "issue") {
        const body = await apiSend<TokenIssuedResponse>(
          "/api/tokens",
          "POST",
          armed.sheet,
          { token: adminToken },
        );
        setIssued(body);
        setFormOpen(false);
        setName("");
        setPicked([]);
        setAdjudicate(false);
      } else if (armed.kind === "grants") {
        await apiSend(
          "/api/tokens/grants",
          "PUT",
          { id: armed.record.id, brains: armed.brains, adjudicate: armed.adjudicate },
          { token: adminToken },
        );
        setEditing(null);
      } else {
        await apiSend(
          "/api/tokens/revoke",
          "POST",
          { id: armed.record.id },
          { token: adminToken },
        );
      }
      await load();
      disarm();
    } catch (err) {
      // single-use by design: the pasted value is gone whether it worked
      // or not. A refused paste keeps the prompt (with its reason) so the
      // admin can try again instead of starting the action over.
      setActionError(stepUpErrorMessage(err, t));
      setAdminToken("");
      armIdle();
      pasteRef.current?.focus();
    } finally {
      setSending(false);
    }
  }

  async function copyIssued() {
    if (!issued) return;
    // never claim "copied" when the browser only allowed a selection
    setCopied((await copyCommandText(issued.token)) ? "copied" : "selected");
    setTimeout(() => setCopied(null), 6000);
  }

  // while the plaintext is on screen the keyboard stays inside the dialog
  useEffect(() => {
    if (!issued) return;
    const node = dialogRef.current;
    const first = node?.querySelector<HTMLElement>("button");
    first?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Tab" || !node) return;
      const focusable = [...node.querySelectorAll<HTMLElement>("button")];
      const index = focusable.indexOf(document.activeElement as HTMLElement);
      if (index === -1) {
        e.preventDefault();
        focusable[0]?.focus();
      } else if (e.shiftKey && index === 0) {
        e.preventDefault();
        focusable.at(-1)?.focus();
      } else if (!e.shiftKey && index === focusable.length - 1) {
        e.preventDefault();
        focusable[0]?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [issued]);

  const active = (rows ?? []).filter((r) => r.revokedAt === null);
  const revokedRows = (rows ?? []).filter((r) => r.revokedAt !== null);

  // the name is judged by the server's own rules before any paste is asked
  // for — including "already taken by an active token"
  const trimmedName = name.trim();
  const nameProblem = trimmedName === "" ? null : checkTokenName(trimmedName);
  const nameTaken =
    trimmedName !== "" && nameProblem === null && nameIsTaken(trimmedName, active.map((r) => r.name));
  const issueReady = trimmedName !== "" && nameProblem === null && !nameTaken && picked.length > 0;

  const armedLabel =
    armed?.kind === "issue"
      ? t("tokens.stepUp.issue")
      : armed?.kind === "grants"
        ? t("tokens.stepUp.grants").replace("{name}", armed.record.name)
        : armed?.kind === "revoke"
          ? t("tokens.stepUp.revoke").replace("{name}", armed.record.name)
          : "";

  function toggle(list: string[], id: string, set: (v: string[]) => void) {
    set(list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);
  }

  return (
    <div className="hcard span8 tk-card">
      <div className="tk-head">
        <div>
          <p className="cap" title={t("tokens.descTitle")}>
            {t("tokens.title")}
          </p>
          <p className="muted small">{t("tokens.desc")}</p>
        </div>
        <button
          ref={issueButtonRef}
          type="button"
          className="btn-press"
          disabled={off || rows === null || formOpen}
          onClick={() => {
            setFormOpen(true);
            setPicked(brain.defaultId ? [brain.defaultId] : []);
          }}
        >
          {t("tokens.issue")}
        </button>
      </div>

      {off && <p className="muted small">{t("tokens.off")}</p>}
      {loadError && (
        <p className="error" role="alert">
          {t("common.errorLabel")}: {loadError}
        </p>
      )}
      {rows === null && !off && !loadError && <p className="muted small">{t("common.loading")}</p>}

      {formOpen && (
        <div className="tk-form">
          <label>
            <span className="cap">{t("tokens.name")}</span>
            <input
              type="text"
              className="text-filter"
              value={name}
              maxLength={60}
              autoComplete="off"
              placeholder={t("tokens.namePlaceholder")}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          {nameProblem && (
            <p className="small error" role="alert">
              {t("tokens.nameInvalid")}
            </p>
          )}
          {nameTaken && (
            <p className="small error" role="alert">
              {t("tokens.nameTaken")}
            </p>
          )}
          <p className="small muted">{t("tokens.nameRule")}</p>
          <div>
            <span className="cap">{t("tokens.brains")}</span>
            <div className="tk-checks">
              {brainIds.map((id) => (
                <label key={id} className="tk-check">
                  <input type="checkbox" checked={picked.includes(id)} onChange={() => toggle(picked, id, setPicked)} />
                  <span className="mono">{id}</span>
                </label>
              ))}
            </div>
          </div>
          <label className="tk-check">
            <input type="checkbox" checked={adjudicate} onChange={(e) => setAdjudicate(e.target.checked)} />
            <span>{t("tokens.grantAdjudicate")}</span>
          </label>
          <p className="muted small">{t("tokens.adjudicateNote")}</p>
          <div className="tk-acts">
            <button
              type="button"
              className="btn-main btn-press"
              disabled={!issueReady}
              onClick={() =>
                arm({ kind: "issue", sheet: { name: trimmedName, brains: picked, adjudicate } })
              }
            >
              {t("tokens.issueConfirm")}
            </button>
            <button type="button" className="linkish" onClick={() => setFormOpen(false)}>
              {t("common.cancel")}
            </button>
          </div>
        </div>
      )}

      {!off && rows !== null && active.length === 0 && !formOpen && (
        <p className="muted small">{t("tokens.empty")}</p>
      )}

      {active.map((row) => (
        <div key={row.id} className="tk-row">
          <div className="tk-body">
            <div className="tk-who">
              <b>{row.name}</b>
              <span className="mono muted small">#{row.id.slice(3, 9)}</span>
              {row.brains.map((b) => (
                <span key={b} className="tag">
                  <span className="mono">{b}</span>
                  {!brainIds.includes(b) && <span className="muted"> · {t("tokens.brainOffline")}</span>}
                </span>
              ))}
              {row.adjudicate ? (
                <span className="tag soft">{t("tokens.perm.adjudicate")}</span>
              ) : (
                <span className="tag soft">{t("tokens.perm.view")}</span>
              )}
            </div>
            <div className="muted small">
              {t("tokens.issuedAt")} {stamp(row.createdAt, locale)} · {t("tokens.lastUsed")}{" "}
              {stamp(row.lastUsedAt, locale)}
            </div>
            {editing?.id === row.id && (
              <div className="tk-form">
                <div>
                  <span className="cap">{t("tokens.brains")}</span>
                  <div className="tk-checks">
                    {brainIds.map((id) => (
                      <label key={id} className="tk-check">
                        <input
                          type="checkbox"
                          checked={editPicked.includes(id)}
                          onChange={() => toggle(editPicked, id, setEditPicked)}
                        />
                        <span className="mono">{id}</span>
                      </label>
                    ))}
                  </div>
                </div>
                <label className="tk-check">
                  <input
                    type="checkbox"
                    checked={editAdjudicate}
                    onChange={(e) => setEditAdjudicate(e.target.checked)}
                  />
                  <span>{t("tokens.grantAdjudicate")}</span>
                </label>
                <div className="tk-acts">
                  <button
                    type="button"
                    className="btn-main btn-press"
                    disabled={editPicked.length === 0}
                    onClick={() =>
                      arm({
                        kind: "grants",
                        record: row,
                        brains: editPicked,
                        adjudicate: editAdjudicate,
                      })
                    }
                  >
                    {t("tokens.save")}
                  </button>
                  <button type="button" className="linkish" onClick={() => setEditing(null)}>
                    {t("common.cancel")}
                  </button>
                </div>
              </div>
            )}
          </div>
          {editing?.id !== row.id && (
            <div className="tk-acts">
              <button
                type="button"
                className="linkish"
                onClick={() => {
                  setEditing(row);
                  // a brain that is gone from brains.json cannot be re-granted:
                  // start from the ones that still exist (shown as offline above)
                  setEditPicked(row.brains.filter((b) => brainIds.includes(b)));
                  setEditAdjudicate(row.adjudicate);
                }}
              >
                {t("tokens.regrant")}
              </button>
              <button
                type="button"
                className="linkish tk-danger"
                onClick={() => arm({ kind: "revoke", record: row })}
              >
                {t("tokens.revoke")}
              </button>
            </div>
          )}
        </div>
      ))}

      {revokedRows.length > 0 && (
        <details className="detail-block">
          <summary className="cap">{t("tokens.revokedCount").replace("{n}", String(revokedRows.length))}</summary>
          {revokedRows.map((row) => (
            <div key={row.id} className="tk-row tk-revoked">
              <div className="tk-body">
                <div className="tk-who">
                  <b>{row.name}</b>
                  <span className="tag stop">{t("tokens.perm.revoked")}</span>
                </div>
                <div className="muted small">
                  {t("tokens.revokedAt")} {stamp(row.revokedAt, locale)} · {row.revokedBy}
                </div>
              </div>
            </div>
          ))}
        </details>
      )}

      {armed && (
        <div className="tk-stepup" role="group" aria-label={t("admin.stepUp.title")}>
          <p className="small">
            <b>{armedLabel}</b>
            {armed.kind === "revoke" && <span className="muted"> {t("tokens.revokeFinal")}</span>}
          </p>
          <input
            ref={pasteRef}
            type="text"
            className="token-masked"
            value={adminToken}
            autoComplete="off"
            spellCheck={false}
            placeholder={t("admin.stepUp.placeholder")}
            onChange={(e) => setAdminToken(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void run();
            }}
          />
          <button
            type="button"
            className="batch-arm"
            disabled={sending || adminToken.length === 0}
            onClick={() => void run()}
          >
            {sending ? t("tokens.working") : t("admin.stepUp.confirm")}
          </button>
          <button type="button" className="linkish" onClick={disarm}>
            {t("common.cancel")}
          </button>
        </div>
      )}
      {actionError && (
        <p className="error" role="alert">
          {actionError}
        </p>
      )}

      {issued && (
        <div
          className="tk-modal"
          role="dialog"
          aria-modal="true"
          aria-labelledby="tk-issued-title"
          ref={dialogRef}
        >
          <div className="tk-modal-card">
            <p className="cap" id="tk-issued-title">
              {t("tokens.issued.title")}
            </p>
            <p>{t("tokens.issued.once").replace("{name}", issued.record.name)}</p>
            {/* a <code> node, never an input: password managers and autofill
                must not capture the token; the id is the clipboard fallback's
                selection target */}
            <code id={`cmd-${commandHash(issued.token)}`} className="tk-plain">
              {issued.token}
            </code>
            <div className="tk-acts">
              <button type="button" className="btn-main btn-press" onClick={() => void copyIssued()}>
                {t("tokens.copy")}
              </button>
              <button
                type="button"
                className="btn-press"
                onClick={() => {
                  setIssued(null);
                  issueButtonRef.current?.focus();
                }}
              >
                {t("tokens.saved")}
              </button>
            </div>
            <p className="muted small">
              {copied === "copied"
                ? t("tokens.copiedHint")
                : copied === "selected"
                  ? t("tokens.copyFallback")
                  : t("tokens.issued.hint")}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
