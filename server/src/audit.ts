import { appendFile, mkdir, readdir, readFile, stat } from "node:fs/promises";
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

/**
 * The newest `limit` entries across the audit files (verdict history's
 * server side): read the newest few day-files, newest entries first.
 * Read failures degrade to whatever parsed — history is best-effort, never
 * a red panel.
 */
export async function auditTail(
  limit: number,
): Promise<Array<Record<string, unknown>>> {
  try {
    const files = (await readdir(DIR))
      .filter((f) => f.endsWith(".jsonl"))
      .sort()
      .reverse()
      .slice(0, 7); // a week of files is plenty for any tail
    const out: Array<Record<string, unknown>> = [];
    for (const f of files) {
      if (out.length >= limit) break;
      try {
        const text = await readFile(join(DIR, f), "utf8");
        const lines = text.split("\n").filter(Boolean);
        for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
          try {
            out.push(JSON.parse(lines[i]!) as Record<string, unknown>);
          } catch {
            // a torn line (mid-write read) is skipped, not fatal
          }
        }
      } catch {
        // unreadable file — try the next older one
      }
    }
    return out;
  } catch {
    return [];
  }
}
