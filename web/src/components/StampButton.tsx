import type { ButtonHTMLAttributes } from "react";
import { useI18n } from "../lib/i18n";

// The verdict stamp button. variant "drop"/"ok" = one-key channel (press =
// translate into the offset shadow). variant "copy" is the mockup's green
// "accept" stamp: it is a COPY affordance for the terminal-confirmation
// command (⌘↵) — the action itself still only happens at the owner's terminal
// (ENG-15). A one-key action and a copy shortcut never share a channel.
//
// The bilingual zh+en stamp is a zh-locale design signature; in the en locale
// the main word is already English, so the sub-line is hidden (no "Drop DROP").

export function StampButton({
  variant,
  zh,
  en,
  how,
  ...rest
}: {
  variant: "drop" | "ok" | "copy";
  zh: string;
  en: string;
  how?: string;
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className" | "type">) {
  const { locale } = useI18n();
  return (
    <button type="button" className={`stamp-btn ${variant}`} {...rest}>
      <span className="zh">{zh}</span>
      {locale === "zh-CN" ? <span className="en">{en}</span> : null}
      {how ? <span className="how">{how}</span> : null}
    </button>
  );
}
