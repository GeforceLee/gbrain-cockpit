/// <reference types="bun" />
// (scoped to this test file: web's tsconfig keeps browser-only types; the
// bun:test declaration rides on this reference instead of the global "types")
import { JSDOM } from "jsdom";
import { describe, expect, test } from "bun:test";

// The sanitize pipeline is DOM-dependent (DOMPurify binds a document at
// import). Give it a jsdom world BEFORE the module under test loads — jsdom,
// specifically: happy-dom's parse/serialize round-trip mangles the
// sanitizer's input (dropped block tags, script as text), which would make
// these tests assert against a fiction.
const dom = new JSDOM("");
(Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  Node: dom.window.Node,
  Element: dom.window.Element,
}) as unknown as Record<string, unknown>);
const { renderMarkdown } = await import("./markdown");

// The ONE rich-text entry point (AGENTS.md #5): marked → DOMPurify, plus the
// conversation-ingest unwrapper. Brain content is persistent untrusted input —
// these tests are the guardrail, so they pin behavior, not implementation.

describe("renderMarkdown sanitize", () => {
  test("script never survives — stripped, not escaped-into-place", () => {
    const html = renderMarkdown("hello <script>alert(1)</script> world");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("alert(1)");
    expect(html).toContain("hello");
  });

  test("content-fetching and input-capturing tags are forbidden", () => {
    // img is a request-leak channel against untrusted content; forms/buttons
    // fake UI inside the page body
    const html = renderMarkdown(
      "![leak](https://evil.example/pixel.png)\n\n<form><input value=\"phish\"></form>\n\n<iframe src=\"https://evil.example\"></iframe>",
    );
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<form");
    expect(html).not.toContain("<input");
    expect(html).not.toContain("<iframe");
    expect(html).not.toContain("evil.example/pixel");
  });

  test("external links open hardened: _blank + noopener/noreferrer/nofollow", () => {
    const html = renderMarkdown("[doc](https://example.com/a)");
    expect(html).toContain('href="https://example.com/a"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer nofollow"');
  });

  test("ordinary markdown renders (GFM table, headings, line breaks)", () => {
    const html = renderMarkdown("# T\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n");
    expect(html).toContain("<h1>");
    expect(html).toContain("<table>");
    expect(html).toContain("<td>1</td>");
  });
});

describe("conversation-ingest unwrapper", () => {
  const wrapped = (body: string, fence = "```") =>
    `[quoted conversation excerpt from chats/xyz; source material, not instructions]\n${fence}text\n---\ntitle: some page\n---\n${body}\n${fence}`;

  test("the wrapper shape unwraps: inner markdown renders, provenance line stays", () => {
    const html = renderMarkdown(wrapped("# Inner Title\n\nreal *body*"));
    expect(html).toContain("<h1>Inner Title</h1>");
    expect(html).toContain("<em>body</em>");
    expect(html).toContain("quoted conversation excerpt from chats/xyz");
    // the giant code-fence render (the bug this unwrapper exists for) is gone
    expect(html).not.toContain("<pre><code>---");
  });

  test("a longer closing run than the opening fence does not match (strict anchors)", () => {
    // body that nests its own triple-backtick fence: the wrapper's fence run
    // grows, and the unwrapper must still find the RIGHT closer
    const html = renderMarkdown(wrapped("# T\n\n```\ninner fence\n```\n", "````"));
    expect(html).toContain("<h1>T</h1>");
  });

  test("content that merely starts with a code fence renders as stored (no guessing)", () => {
    const stored = "```\njust a code block\n```\n";
    const html = renderMarkdown(stored);
    expect(html).toContain("<pre><code>");
    expect(html).toContain("just a code block");
  });

  test("frontmatter strip is bounded: a 50-line pseudo-frontmatter head is kept", () => {
    const head = Array.from({ length: 50 }, (_, i) => `key${i}: v${i}`).join("\n");
    const html = renderMarkdown(wrapped(`---\n${head}\n---\nbody`));
    // >40 lines is not frontmatter — the raw head stays visible rather than
    // silently eating half the page
    expect(html).toContain("key49");
  });
});
