import { useState } from "react";
import { setToken } from "../lib/api";
import { useI18n } from "../lib/i18n";

// App-level token gate: the instance is unreachable without COCKPIT_TOKEN,
// so every panel hides behind one entry screen instead of each panel failing
// with "no token stored" (first-run UX lesson from the leewin deployment).

export function TokenGate({ onAuthed }: { onAuthed: () => void }) {
  const { t } = useI18n();
  const [draft, setDraft] = useState("");

  return (
    <section className="panel token-gate">
      <h2>{t("health.token.label")}</h2>
      <form
        className="token-form"
        onSubmit={(e) => {
          e.preventDefault();
          const value = draft.trim();
          if (!value) return;
          setToken(value);
          onAuthed();
        }}
      >
        <label htmlFor="cockpit-token">{t("health.token.label")}</label>
        <input
          id="cockpit-token"
          type="password"
          autoComplete="off"
          placeholder={t("health.token.placeholder")}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
        <button type="submit">{t("health.connect")}</button>
        <p className="hint">{t("health.token.hint")}</p>
      </form>
    </section>
  );
}
