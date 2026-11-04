// Session audit log — the fixed receipt slot behind the ink audit block.
// Adjudication and write actions append machine lines here (mono, ASCII,
// never localized: this is a machine product). Style-review hard constraint:
// receipts live in a fixed slot, never in a disappearing toast.

export interface AuditLine {
  id: number;
  /** HH:MM:SS (local clock, second precision is enough for a session log) */
  at: string;
  text: string;
}

let nextId = 1;
let lines: readonly AuditLine[] = [];
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function appendAudit(text: string): void {
  const line: AuditLine = {
    id: nextId++,
    at: new Date().toISOString().slice(11, 19),
    text,
  };
  lines = [...lines.slice(-199), line];
  emit();
}

export function getAuditLines(): readonly AuditLine[] {
  return lines;
}

export function subscribeAudit(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
