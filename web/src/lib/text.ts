// Small shared text helpers (extracted from per-panel copies).

/** Errors shown to the browser stay one line — full text is server-log only. */
export function firstLine(error?: string): string {
  if (!error) return "";
  return (error.split("\n").find((l) => l.trim()) ?? "").slice(0, 220);
}
