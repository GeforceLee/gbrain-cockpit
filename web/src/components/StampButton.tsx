import type { ButtonHTMLAttributes } from "react";

// The verdict stamp button — one-key channel ONLY. Press = translate into the
// offset shadow (stamps down). Terminal-confirmation actions never render as
// this component: they are copy-command blocks by structural constraint
// (action trichotomy; same component never recolors to mean another channel).

export function StampButton({
  variant,
  zh,
  en,
  how,
  ...rest
}: {
  variant: "drop" | "ok";
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
