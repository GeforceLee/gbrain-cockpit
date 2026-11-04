import type { ButtonHTMLAttributes } from "react";

// The verdict stamp button. variant "drop"/"ok" = one-key channel (press =
// translate into the offset shadow). variant "copy" is the mockup's green
// "accept" stamp: it is a COPY affordance for the terminal-confirmation
// command (⌘↵) — the action itself still only happens at the owner's terminal
// (ENG-15). A one-key action and a copy shortcut never share a channel.

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
  return (
    <button type="button" className={`stamp-btn ${variant}`} {...rest}>
      <span className="zh">{zh}</span>
      <span className="en">{en}</span>
      {how ? <span className="how">{how}</span> : null}
    </button>
  );
}
