import type { ReactNode } from "react";

// v5 tag family: mono, 2px ink border, semantic variants. Semantic colors are
// dedicated (专色专用): warn is only real warnings, stop only destructive
// verdicts, term marks terminal-channel material.

export type TagVariant = "plain" | "soft" | "warn" | "stop" | "ok" | "term";

export function Tag({
  variant = "plain",
  children,
}: {
  variant?: TagVariant;
  children: ReactNode;
}) {
  return (
    <span className={variant === "plain" ? "tag" : `tag ${variant}`}>
      {children}
    </span>
  );
}
