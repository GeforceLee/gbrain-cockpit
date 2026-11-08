// Small shared text helpers (extracted from per-panel copies).

/** Errors shown to the browser stay one line — full text is server-log only. */
export function firstLine(error?: string): string {
  if (!error) return "";
  return (error.split("\n").find((l) => l.trim()) ?? "").slice(0, 220);
}

/**
 * Markdown-syntax stripper for one-line excerpts (relation contexts and the
 * like): untrusted content stays PLAIN TEXT — this only removes noise
 * (`**bold**`, `[x|label]` wiki links, `[x](y)` links, list bullets) so raw
 * markers never leak into the UI. It never renders anything.
 */
export function plainExcerpt(text: string): string {
  return text
    .replace(/\[([^\]|]*)\|([^\]]*)\]/g, "$2") // [slug|LABEL] → LABEL
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // [x](y) → x
    .replace(/\*\*|__|`/g, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}
