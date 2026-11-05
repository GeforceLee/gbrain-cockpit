import DOMPurify from "dompurify";
import { marked } from "marked";

// The ONE rich-text pipeline (AGENTS.md #5 / ARCHITECTURE 渲染净化): page
// bodies are markdown — verified 2026-11-05 against upstream docs ("your
// brain repo holds the Markdown; the database is an index rebuildable from
// it") and a 50-page sample of the real brain (50/50 carry md syntax, 0
// plain prose) — AND persistent untrusted input: imported pages carry
// third-party web/mail/chat text. marked renders, DOMPurify sanitizes, and
// nothing rich reaches the DOM by any other route.

// GFM for tables/strikethrough (real pages carry tables); breaks:true —
// this brain's pages are chat-excerpt shaped, where single newlines are
// meant as line breaks.
marked.setOptions({ gfm: true, breaks: true });

// External links open in a protected tab — never a same-tab navigation away
// from the desk, never an opener handle back into the app.
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  const el = node as Element;
  if (el.tagName === "A" && el.getAttribute("href")) {
    el.setAttribute("target", "_blank");
    el.setAttribute("rel", "noopener noreferrer nofollow");
  }
});

/** Tags that fetch remote content or capture input stay out until the
 *  matching features (image preview etc.) are designed deliberately —
 *  untrusted <img src> is also a request-leak channel. */
const FORBID_TAGS = [
  "img", "picture", "source", "iframe", "object", "embed", "video", "audio",
  "form", "input", "button", "select", "textarea", "style", "script",
];
const FORBID_ATTR = ["style", "srcset", "background"];

/** markdown string → sanitized HTML string (the only such function). */
export function renderMarkdown(content: string): string {
  return DOMPurify.sanitize(marked.parse(content, { async: false }) as string, {
    FORBID_TAGS,
    FORBID_ATTR,
  });
}
