import { useMemo } from "react";
import { renderMarkdown } from "../lib/markdown";

// PageBody — the single component through which page bodies enter the DOM
// as rich text (Pages detail, PageDrawer, the Nebula peek). Raw markdown in,
// marked → DOMPurify out (lib/markdown.ts). This dangerouslySetInnerHTML is
// the ONLY sanctioned one in the app: never feed it unsanitized input, never
// add a second rich-text path (AGENTS.md #5).

export function PageBody({
  content,
  className = "",
}: {
  content: string;
  /** host surface class carrying the chrome (.page-content / .drawer-content) */
  className?: string;
}) {
  const html = useMemo(() => renderMarkdown(content), [content]);
  return (
    <div
      className={`md-body ${className}`}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
