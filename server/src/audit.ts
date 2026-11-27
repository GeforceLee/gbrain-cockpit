import {
  appendFile,
  chmod,
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { actorName, type Actor } from "./authz";

// Write-action audit trail (ARCHITECTURE §5-9): JSONL under
// ~/.cockpit-audit/ — outside the program directory, one file per day,
// rotated by size. Audit failures must never fail the audited request;
// they surface as server-log warnings only.
//
// 0.7 (named tokens): the "who" is the caller's Actor — a named token
// lands as its sheet name plus `actor_kind: "token"` and its `actor_id`
// (the id is what audit READERS must key on; the name is for humans). The
// directory and files are private to the service user (0700 / 0600): the
// trail now lists every person's name and grants. Token-management actions
// use `auditWriteStrict` — for those, no audit line means no change.

const DIR = join(homedir(), ".cockpit-audit");
const ROTATE_BYTES = 10 * 1024 * 1024;

export class AuditWriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuditWriteError";
  }
}

export interface AuditEntry {
  action: string;
  /** which brain profile the action targeted (multi-brain provenance) */
  profile?: string;
  detail?: Record<string, unknown>;
}

/** A string stays accepted (call sites that predate actors); an Actor
 *  carries the kind and id the trail keys on. Undefined reads as the owner. */
export type AuditActor = string | Actor | undefined;

/** Best-effort line (the 0.6 contract). False when it could not be written. */
export async function auditWrite(
  actor: AuditActor,
  entry: AuditEntry,
): Promise<boolean> {
  try {
    await appendLine(lineFor(actor, entry));
    return true;
  } catch (err) {
    console.warn(`[audit] failed to write entry: ${(err as Error).message}`);
    return false;
  }
}

/** The strict twin: throws when the line does not land. */
export async function auditWriteStrict(
  actor: AuditActor,
  entry: AuditEntry,
): Promise<void> {
  await appendLine(lineFor(actor, entry));
}

/**
 * Startup self-check: create the directory, make it and the existing day
 * files private, and prove the trail is writable BEFORE the first write
 * action. A cockpit that cannot audit must say so at boot, not mid-action.
 */
export async function ensureAuditWritable(): Promise<void> {
  await mkdir(DIR, { recursive: true, mode: 0o700 });
  await chmod(DIR, 0o700);
  for (const f of await readdir(DIR)) {
    if (!f.endsWith(".jsonl")) continue;
    await chmod(join(DIR, f), 0o600).catch(() => undefined);
  }
  // A real write, not access(W_OK): as root that answers yes even on a
  // read-only filesystem. Failure propagates — the boot must not continue.
  const probe = join(DIR, `.probe-${process.pid}`);
  try {
    await appendFile(probe, "", { mode: 0o600 });
  } finally {
    await rm(probe, { force: true });
  }
}

function lineFor(actor: AuditActor, entry: AuditEntry): string {
  const name = typeof actor === "string" ? actor : actorName(actor);
  const base: Record<string, unknown> = {
    at: new Date().toISOString(),
    actor: name,
    ...entry,
  };
  if (typeof actor === "object" && actor !== undefined) {
    base.actor_kind = actor.kind;
    if (actor.tokenId !== undefined) base.actor_id = actor.tokenId;
  }
  return `${JSON.stringify(base)}\n`;
}

async function appendLine(line: string): Promise<void> {
  await mkdir(DIR, { recursive: true, mode: 0o700 });
  const day = new Date().toISOString().slice(0, 10);
  let file = join(DIR, `${day}.jsonl`);
  try {
    const { size } = await stat(file);
    if (size > ROTATE_BYTES) file = join(DIR, `${day}.1.jsonl`);
  } catch {
    // first write of the day — file doesn't exist yet
  }
  try {
    await appendFile(file, line, { encoding: "utf8", mode: 0o600 });
  } catch (err) {
    throw new AuditWriteError(
      `audit trail not writable (${file}): ${(err as Error).message}`,
    );
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
