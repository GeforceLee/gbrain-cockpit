import { useState, type FormEvent } from "react";
import { ApiError, setToken, takeLogoutReason, verifyToken } from "../lib/api";
import { setMe } from "../lib/me";
import { useI18n } from "../lib/i18n";

// App-level token gate: the instance is unreachable without a token, so
// every panel hides behind one entry screen instead of each panel failing
// with "no token stored" (first-run UX lesson from the leewin deployment).
//
// 0.7: the token is verified BEFORE it is stored — a wrong or revoked one is
// refused right here with a plain reason, instead of being saved and then
// bouncing every panel into 401s. The field is a plain text input with a
// CSS mask, not a password field: browsers save and autofill password
// fields, which is the last thing a shared computer wants.

export function TokenGate({ onAuthed }: { onAuthed: () => void }) {
  const { t } = useI18n();
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // set by the api client right before it reloaded us here (one-shot)
  const [revoked] = useState(() => takeLogoutReason() === "revoked");

  async function submit(e: FormEvent) {
    e.preventDefault();
    const value = draft.trim();
    if (!value || busy) return;
    setBusy(true);
    setError(null);
    try {
      // remember who this is right away: a later /api/me hiccup must not
      // leave the session without an identity
      setMe(await verifyToken(value));
      setToken(value);
      onAuthed();
    } catch (err) {
      // only the server refusing the token (401) means the token is wrong;
      // a timeout or a 5xx means the server could not be asked
      setError(
        err instanceof ApiError && err.status === 401 ? t("gate.invalid") : t("gate.unreachable"),
      );
      setDraft("");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel token-gate">
      <h2>{t("health.token.label")}</h2>
      <p className="panel-desc">{t("app.tagline")}</p>
      {revoked && (
        <p className="error" role="alert">
          {t("gate.revoked")}
        </p>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <form className="token-form" onSubmit={(e) => void submit(e)}>
        <label htmlFor="cockpit-token">{t("gate.field")}</label>
        <input
          id="cockpit-token"
          className="token-masked"
          type="text"
          autoComplete="off"
          spellCheck={false}
          placeholder={t("gate.placeholder")}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
        <button type="submit" disabled={busy}>
          {busy ? t("gate.checking") : t("health.connect")}
        </button>
        <p className="hint">{t("gate.hint")}</p>
      </form>
    </section>
  );
}
