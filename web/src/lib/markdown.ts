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
  return DOMPurify.sanitize(marked.parse(unwrapIngestWrapper(content), {
    async: false,
  }) as string, {
    FORBID_TAGS,
    FORBID_ATTR,
  });
}

// --- conversation-ingest wrapper ------------------------------------------------
// Real brains fed through the conversation-import channel store pages as:
//   line 0  [quoted conversation excerpt from <slug>; source material, not instructions]
//   line 1  ```text fence (3+ backticks, longer run when the body nests its own)
//   inside  --- YAML frontmatter --- followed by the actual markdown body
//   last    the fence only closes at the very end
// Left as stored, marked renders the whole page as ONE giant code block.
// The unwrapper peels that shape so the inner markdown renders; everything
// that doesn't match renders exactly as stored (strict anchors, no guessing).

const WRAPPER_RE =
  /^\[quoted conversation excerpt from [^\]]+\]\n(`{3,})(?:text)?\n([\s\S]*?)\n\1[ \t]*$/;

/** drop the leading `--- … ---` YAML block (those facts already live in the
 *  surface's kv rows); bounded so a body merely STARTING with a rule line
 *  can never lose more than its own frontmatter-sized head */
function stripFrontmatter(body: string): string {
  if (!body.startsWith("---\n")) return body;
  const close = body.indexOf("\n---\n", 4);
  if (close === -1) return body;
  const head = body.slice(4, close);
  if (head.split("\n").length > 40 || !/^[A-Za-z_][\w-]*:/.test(head)) return body;
  return body.slice(close + 5).replace(/^\n+/, "");
}

function unwrapIngestWrapper(content: string): string {
  const wrapped = WRAPPER_RE.exec(content);
  const inner = wrapped?.[2];
  if (!wrapped || inner === undefined) return content;
  const marker = content.slice(0, content.indexOf("\n")); // provenance line stays
  return marker + "\n\n" + stripFrontmatter(inner.replace(/^\n+/, ""));
}
