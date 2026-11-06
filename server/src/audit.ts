import { appendFile, mkdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

// Write-action audit trail (ARCHITECTURE §5-9): JSONL under
// ~/.cockpit-audit/ — outside the program directory, one file per day,
// rotated by size. Audit failures must never fail the audited request;
// they surface as server-log warnings only.

const DIR = join(homedir(), ".cockpit-audit");
const ROTATE_BYTES = 10 * 1024 * 1024;

export interface AuditEntry {
  action: string;
  /** which brain profile the action targeted (multi-brain provenance) */
  profile?: string;
  detail?: Record<string, unknown>;
}

export async function auditWrite(
  actor: string,
  entry: AuditEntry,
): Promise<void> {
  try {
    await mkdir(DIR, { recursive: true });
    const day = new Date().toISOString().slice(0, 10);
    let file = join(DIR, `${day}.jsonl`);
    try {
      const { size } = await stat(file);
      if (size > ROTATE_BYTES) file = join(DIR, `${day}.1.jsonl`);
    } catch {
      // first write of the day — file doesn't exist yet
    }
    await appendFile(
      file,
      `${JSON.stringify({ at: new Date().toISOString(), actor, ...entry })}\n`,
      "utf8",
    );
  } catch (err) {
    console.warn(`[audit] failed to write entry: ${(err as Error).message}`);
  }
}
