// Session audit log — the fixed receipt slot behind the ink audit block.
// Adjudication and write actions append machine lines here (mono, ASCII,
// never localized: this is a machine product). Style-review hard constraint:
// receipts live in a fixed slot, never in a disappearing toast.
//
// Entries optionally carry structured meta (ref / verdict / label) which the
// Recent-Verdicts table renders; plain text entries (older callers) still
// show in the audit block unchanged.

export type VerdictKind = "ok" | "stop" | "warn";

export interface AuditMeta {
  /** machine ref of the target, e.g. tp-1104-07 / edge #12 / a page slug */
  ref: string;
  /** human label for the Recent-Verdicts table (already localized) */
  label?: string;
  /** ministamp color class for the verdict column */
  verdict: VerdictKind;
  /** localized verdict word for the ministamp */
  verdictText: string;
  /** receipt id when one exists (page writes), else "—" */
  receipt?: string;
}

export interface AuditLine {
  id: number;
  /** HH:MM:SS (local clock, second precision is enough for a session log) */
  at: string;
  text: string;
  meta?: AuditMeta;
}

let nextId = 1;
let lines: readonly AuditLine[] = [];
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function appendAudit(text: string, meta?: AuditMeta): void {
  const line: AuditLine = {
    id: nextId++,
    at: new Date().toISOString().slice(11, 19),
    text,
    ...(meta ? { meta } : {}),
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
