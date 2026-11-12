import {
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// cockpit-owned Inbox relief state (0.5.2, owner D2 option A): per-source
// mutes and per-proposal snoozes, one small JSON per deployment keyed by
// brain profile. NOT gbrain state — nothing here ever touches the brain
// database (AGENTS.md #2); the file holds ids and source names only, never
// secrets. One file per server process (a double-opened second server would
// last-write-wins — declared here, not defended against).
//
// Discipline (review-pinned):
// - path: COCKPIT_INBOX_STATE_FILE explicit → else alongside the profiles
//   file (release-safe on redeploy-managed hosts) → else ~/.cockpit/ —
//   NEVER the cwd (systemd WorkingDirectory IS the release dir there; a
//   state file there dies on the next deploy).
// - read-modify-write always under one in-process mutex (promise chain).
// - write = same-dir unique tmp + rename (atomic), mode 0600.
// - corrupt JSON is FAIL-VISIBLE: reads return the error with an empty
//   state, mutations refuse — the file is never silently overwritten
//   (that would wipe the user's hand-made mutes/snoozes).

export interface InboxSnoozeEntry {
  id: number;
  source: string;
  snoozedAt: string;
  /** the source's last_source_cycle_at AT SNOOZE TIME, verbatim string
   *  (undefined = the source had no stamp then). Resurrection = strict
   *  string inequality against the CURRENT stamp — same SQL extraction both
   *  times, never Date.parse, never a wall clock. */
  stamp?: string;
}

export interface InboxProfileState {
  muted: Array<{ source: string; at: string }>;
  snoozed: InboxSnoozeEntry[];
}

interface InboxStateFile {
  version: 1;
  profiles: Record<string, InboxProfileState>;
}

export function emptyInboxState(): InboxProfileState {
  return { muted: [], snoozed: [] };
}

export interface InboxStateSnapshot {
  state: InboxProfileState;
  /** the file exists but is unreadable/corrupt (fail-visible; an empty
   *  state rides along so reads still render the queue) */
  error?: string;
}

export interface InboxStateStore {
  readonly path: string;
  /** test-overridable clock for entry stamps */
  now(): string;
  read(profileId: string): Promise<InboxStateSnapshot>;
  /** fn runs under the store's mutex against the live file state; throwing
   *  (e.g. the fail-visible corrupt refusal) leaves the file untouched */
  mutate(
    profileId: string,
    fn: (state: InboxProfileState) => void,
  ): Promise<InboxStateSnapshot>;
}

export interface CreateInboxStateStoreOpts {
  /** explicit file path (COCKPIT_INBOX_STATE_FILE) */
  file?: string | null;
  /** the profiles file path — state rides alongside when no explicit file */
  profilesFile?: string | null;
  /** injectable for tests */
  now?: () => string;
}

export function resolveInboxStatePath(
  opts: Pick<CreateInboxStateStoreOpts, "file" | "profilesFile"> = {},
): string {
  const explicit = opts.file?.trim();
  if (explicit) return explicit;
  const profiles = opts.profilesFile?.trim();
  if (profiles) return join(dirname(profiles), "inbox-state.json");
  return join(homedir(), ".cockpit", "inbox-state.json");
}

export function createInboxStateStore(
  opts: CreateInboxStateStoreOpts = {},
): InboxStateStore {
  const path = resolveInboxStatePath(opts);
  const now = opts.now ?? (() => new Date().toISOString());

  function parseFile(): { data: InboxStateFile; error?: string } {
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch {
      return { data: { version: 1, profiles: {} } }; // absent = normal first run
    }
    try {
      const parsed = JSON.parse(raw) as InboxStateFile;
      if (
        parsed === null ||
        typeof parsed !== "object" ||
        parsed.profiles === null ||
        typeof parsed.profiles !== "object"
      ) {
        throw new Error("not an inbox-state file");
      }
      return { data: { version: 1, profiles: parsed.profiles } };
    } catch (err) {
      return {
        data: { version: 1, profiles: {} },
        error: `inbox state file unreadable (${path}): ${err instanceof Error ? err.message : String(err)} — refusing to overwrite it`,
      };
    }
  }

  function profileOf(data: InboxStateFile, id: string): InboxProfileState {
    const p = data.profiles[id];
    if (p === null || typeof p !== "object") return emptyInboxState();
    return {
      muted: Array.isArray(p.muted) ? p.muted : [],
      snoozed: Array.isArray(p.snoozed) ? p.snoozed : [],
    };
  }

  // one in-process mutex over the whole read-modify-write
  let chain: Promise<unknown> = Promise.resolve();
  function serialized<T>(run: () => Promise<T> | T): Promise<T> {
    const next = chain.then(run, run);
    // the chain survives a failed op; the op's own rejection surfaces to its caller
    chain = next.catch(() => undefined);
    return next;
  }

  function persist(data: InboxStateFile): void {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = join(
      dirname(path),
      `.inbox-state.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`,
    );
    writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
    renameSync(tmp, path);
  }

  return {
    path,
    now,
    read(profileId) {
      return serialized(() => {
        const { data, error } = parseFile();
        return { state: profileOf(data, profileId), ...(error ? { error } : {}) };
      });
    },
    mutate(profileId, fn) {
      return serialized(() => {
        const { data, error } = parseFile();
        if (error) throw new Error(error);
        const state = profileOf(data, profileId);
        fn(state);
        data.profiles[profileId] = state;
        persist(data);
        return { state };
      });
    },
  };
}
