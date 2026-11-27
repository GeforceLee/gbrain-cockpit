import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";
import {
  PROFILE_ID_RE,
  isValidSourceId,
  type TokenRecord,
} from "@gbrain-cockpit/shared";
import { ConfigError } from "./config";

// The named-token registry (0.7, ROADMAP-named-tokens §3.1): one small
// machine-local JSON holding every token cockpit issued — SHA-256 digests
// only, never a plaintext token. It is cockpit's OWN state (never the brain
// database, AGENTS.md non-negotiable #2) and the authorization store, so its
// discipline is stricter than the inbox state file it borrows its atomic
// write from:
//
// - READ fails closed. The env var names the file; the file must then exist,
//   be a regular non-symlink owned by the service user (or root), sit in a
//   directory chain nobody else can write, and parse with zero unknown
//   fields — anything else refuses the boot. A sheet this code cannot
//   understand is neither granted nor revoked; it is a dead registry.
// - WRITE is audit-first. Mutations compute the next state (all validation
//   before any I/O), write the audit line (failure ⇒ nothing changes), then
//   persist atomically (temp file + fsync + rename + dir fsync) and only
//   then swap memory. There is no rollback: on a full disk the rollback
//   write would fail too, and the file and memory would disagree.
// - ONE server per registry. A lock file beside the registry (holder pid)
//   refuses a second instance, which would otherwise resurrect revocations
//   with its next write. A hand edit underneath a running server is caught
//   by an inode + mtime check before every persist.
//
// Path rules in index.ts: explicit COCKPIT_TOKENS_FILE (absolute) or the
// feature is off.

export class TokenValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TokenValidationError";
  }
}

export class TokenNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TokenNotFoundError";
  }
}

export class TokenRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TokenRegistryError";
  }
}

/** One registry row, exactly as stored. `hash` is the SHA-256 of the full
 *  token string; nothing here can authenticate anyone on its own. */
export interface TokenEntry {
  id: string;
  name: string;
  hash: string;
  brains: string[];
  adjudicate: boolean;
  editSources: string[];
  createdAt: string;
  createdBy: string;
  revokedAt: string | null;
  revokedBy: string | null;
  lastUsedAt: string | null;
}

interface RegistryFile {
  version: 1;
  tokens: TokenEntry[];
}

export interface TokenRegistryDeps {
  /** the brain profile ids that exist right now (brains.json) */
  knownBrains?: () => Set<string>;
  /** must write or throw — runs BEFORE the registry changes */
  auditStrict?: (action: string, detail: Record<string, unknown>) => Promise<void>;
  /** best-effort — the "failed" compensation line */
  auditSoft?: (action: string, detail: Record<string, unknown>) => Promise<void>;
  /** injectable for tests */
  now?: () => string;
  /** injectable for tests: the lock's grace/wait windows (defaults: seconds) */
  lockGraceMs?: number;
  lockWaitMs?: number;
}

export interface NewTokenInput {
  name: unknown;
  brains: unknown;
  adjudicate: unknown;
  editSources?: unknown;
}

export interface GrantSheet {
  brains: unknown;
  adjudicate: unknown;
  editSources: unknown;
}

/** `ck_` + 43 base64url chars = 256 bits of entropy. The prefix makes a
 *  pasted token recognisable and keeps it out of other secrets' shapes. */
const TOKEN_RE = /^ck_[A-Za-z0-9_-]{43}$/;
const ID_RE = /^tk_[0-9a-f]{12}$/;
const HASH_RE = /^[0-9a-f]{64}$/;
const MAX_ACTIVE = 500;
/**
 * Size bounds. The soft cap refuses the one operation that GROWS the file
 * (issue) — never a revoke, which must always go through. The hard cap is
 * only a runaway guard on a hand-made file. Between them the file
 * self-heals: revoked tombstones older than TOMBSTONE_DAYS are pruned on
 * every write (the audit trail keeps every issue/revoke with the token id
 * and name, so an old tombstone adds nothing the trail does not have).
 */
const MAX_FILE_BYTES = 1024 * 1024;
const HARD_FILE_BYTES = 4 * 1024 * 1024;
const TOMBSTONE_MS = 180 * 24 * 60 * 60 * 1000;
const LAST_USED_PERSIST_MS = 60 * 60 * 1000;
const LAST_USED_MIN_DELTA_MS = 60 * 1000;
/** the lock: how long a starter waits for a fellow starter, and how long an
 *  empty lock (or takeover guard) is given before it counts as abandoned */
const LOCK_WAIT_MS = 15_000;
const LOCK_GRACE_MS = 5_000;

/** Editing opens in the second step (the per-source write channel is not
 *  wired yet): the sheet carries the field but it must stay empty. */
const EDIT_GRANTS_OPEN = false;

const ENTRY_KEYS = [
  "id",
  "name",
  "hash",
  "brains",
  "adjudicate",
  "editSources",
  "createdAt",
  "createdBy",
  "revokedAt",
  "revokedBy",
  "lastUsedAt",
] as const;

// --- token names (ROADMAP-named-tokens appendix B8) --------------------------
// Order matters. NFKC folds fullwidth and mathematical look-alikes back to
// ASCII; a character WHITELIST (not a blocklist) keeps zero-width marks,
// bidi controls, combining marks and Cyrillic/Greek homoglyphs out
// structurally; reserved words and duplicates compare on a "skeleton"
// (separators dropped, digits folded to letters, lowercased) so `Owner`,
// `0wner` and `owner_2` all read as `owner`.

const NAME_CHARS = /^[\p{Script=Han}A-Za-z0-9 ._()·-]+$/u;
const NAME_HAS_LETTER = /[\p{Script=Han}A-Za-z]/u;
const SKELETON_CHARS = /[\p{Script=Han}A-Za-z0-9]/u;
const DIGIT_FOLD: Readonly<Record<string, string>> = {
  "0": "o",
  // "1" folds to i (and l folds to i below), so adm1n / admln / 4dm1n all
  // read as "admin": the target is impersonation, not letter-perfect equality
  "1": "i",
  "3": "e",
  "4": "a",
  "5": "s",
  "7": "t",
  "8": "b",
  "9": "g",
};

export function normalizeTokenName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.normalize("NFKC").replace(/\s+/gu, " ").trim();
  const length = [...s].length;
  if (length < 1 || length > 40) return null;
  if (!NAME_CHARS.test(s)) return null;
  if (!NAME_HAS_LETTER.test(s)) return null;
  return s;
}

export function nameSkeleton(name: string): string {
  return [...name.normalize("NFKC")]
    .filter((ch) => SKELETON_CHARS.test(ch))
    .map((ch) => DIGIT_FOLD[ch] ?? ch.toLowerCase())
    .map((ch) => (ch === "l" ? "i" : ch))
    .join("")
    // two-letter look-alikes: "rn" reads as m, "vv" as w
    .replace(/rn/g, "m")
    .replace(/vv/g, "w");
}

/** Words nobody but the admin may be called in an audit line. Checked on the
 *  skeleton (for Latin) and on the name itself (for the Chinese ones). */
const RESERVED_SKELETONS = ["owner", "admin", "root"];
const RESERVED_WORDS = ["管理员", "业主"];

export function isReservedTokenName(name: string): boolean {
  const skeleton = nameSkeleton(name);
  return (
    RESERVED_SKELETONS.some((word) => skeleton.includes(word)) ||
    RESERVED_WORDS.some((word) => name.includes(word))
  );
}

// --- the registry --------------------------------------------------------------

export class TokenRegistry {
  readonly path: string;
  readonly #deps: TokenRegistryDeps;
  #file: RegistryFile;
  /** digest → ACTIVE entry */
  #byHash = new Map<string, TokenEntry>();
  #chain: Promise<unknown> = Promise.resolve();
  #lockPath: string | null = null;
  /** this instance's share of the lock file's content — dispose only removes
   *  a lock that is still ours */
  #lockNonce: string | null = null;
  #ino: number;
  #mtimeMs: number;
  #size: number;
  #lastUsedPersist = Date.now();

  private constructor(
    file: string,
    data: RegistryFile,
    deps: TokenRegistryDeps,
    stat: { ino: number; mtimeMs: number; size: number },
  ) {
    this.path = file;
    this.#deps = deps;
    this.#file = data;
    this.#ino = stat.ino;
    this.#mtimeMs = stat.mtimeMs;
    this.#size = stat.size;
  }

  /**
   * Load + validate + lock. Every failure is a ConfigError (startup is
   * fatal): the file must exist, be sane, and parse with no unknown fields.
   */
  static load(file: string, deps: TokenRegistryDeps = {}): TokenRegistry {
    const known = deps.knownBrains?.() ?? new Set<string>();
    const { text, stat } = readRegistryFile(file);
    let data: RegistryFile;
    try {
      data = parseRegistry(text, known);
    } catch (err) {
      throw new ConfigError(
        `COCKPIT_TOKENS_FILE is not a valid token registry: ${file}`,
        `fix it as the owner: ${(err as Error).message}. cockpit never echoes the file's contents here.`,
      );
    }
    // the identity of the file we actually READ (from its descriptor), so a
    // swap between the read and a later path stat cannot slip past
    const registry = new TokenRegistry(file, data, deps, stat);
    registry.#acquireLock();
    registry.#rebuild();
    return registry;
  }

  /** The active entry for a bearer header, or null (revoked = absent). */
  verify(authorizationHeader: string | null): TokenEntry | null {
    const match = /^Bearer\s+(.+)$/.exec(authorizationHeader ?? "");
    const presented = match?.[1];
    if (!presented || !TOKEN_RE.test(presented)) return null;
    // Hash first, then a map lookup on the digest: the lookup time depends
    // on a value the attacker cannot influence, so there is no timing
    // oracle on the token (the env verifier keeps timingSafeEqual).
    const entry = this.#byHash.get(sha256Hex(presented));
    if (entry) this.#touch(entry);
    return entry ?? null;
  }

  /** Management view: active first (newest first), then revoked. No hashes. */
  list(): TokenRecord[] {
    const rows = [...this.#file.tokens];
    rows.sort((a, b) => {
      const ra = a.revokedAt === null ? 0 : 1;
      const rb = b.revokedAt === null ? 0 : 1;
      if (ra !== rb) return ra - rb;
      return b.createdAt.localeCompare(a.createdAt);
    });
    return rows.map(toRecord);
  }

  /** Brain ids the registry loads with a warning: the sheet names a brain
   *  that is no longer in brains.json (requests for it answer 403). */
  unknownBrains(): string[] {
    const known = this.#deps.knownBrains?.() ?? new Set<string>();
    const out = new Set<string>();
    for (const t of this.#file.tokens) {
      if (t.revokedAt !== null) continue;
      for (const b of t.brains) if (!known.has(b)) out.add(b);
    }
    return [...out];
  }

  async issue(
    input: NewTokenInput,
    by: string,
  ): Promise<{ token: string; record: TokenRecord }> {
    const name = normalizeTokenName(input.name);
    if (name === null) {
      throw new TokenValidationError(
        "name must be 1–40 characters of Han or Latin letters, digits, spaces and - _ . · ( ), with at least one letter",
      );
    }
    if (isReservedTokenName(name)) {
      throw new TokenValidationError("that name is reserved for the owner");
    }
    const brains = parseBrains(input.brains, this.#known());
    const adjudicate = parseBoolean(input.adjudicate, "adjudicate");
    const editSources = parseEditSources(input.editSources);
    const token = `ck_${randomBytes(32).toString("base64url")}`;
    const entry: TokenEntry = {
      id: `tk_${randomBytes(6).toString("hex")}`,
      name,
      hash: sha256Hex(token),
      brains,
      adjudicate,
      editSources,
      createdAt: this.#now(),
      createdBy: by,
      revokedAt: null,
      revokedBy: null,
      lastUsedAt: null,
    };
    await this.#commit(
      "token.issue",
      { token_id: entry.id, name, brains, adjudicate, editSources },
      (file) => {
        const active = file.tokens.filter((t) => t.revokedAt === null);
        if (active.length >= MAX_ACTIVE) {
          throw new TokenValidationError(
            `the registry is at its cap of ${MAX_ACTIVE} active tokens — revoke unused ones first`,
          );
        }
        const skeleton = nameSkeleton(name);
        const twin = active.find((t) => nameSkeleton(t.name) === skeleton);
        if (twin) {
          throw new TokenValidationError(
            `an active token named "${twin.name}" already exists — names must not be confusable`,
          );
        }
        file.tokens.push(entry);
      },
      { mayGrow: true },
    );
    return { token, record: toRecord(entry) };
  }

  /** Replace the whole sheet (full form, never a patch). */
  async setGrants(id: string, sheet: GrantSheet, by: string): Promise<TokenRecord> {
    assertTokenId(id);
    const entry = this.#requireActive(id);
    // the whole sheet, always: a missing editSources would silently clear it
    if (sheet.editSources === undefined) {
      throw new TokenValidationError(
        "editSources must be sent — an empty array while edit grants are closed",
      );
    }
    const before = sheetOf(entry);
    const brains = parseBrains(sheet.brains, this.#known());
    const adjudicate = parseBoolean(sheet.adjudicate, "adjudicate");
    const editSources = parseEditSources(sheet.editSources);
    await this.#commit(
      "token.grants",
      { token_id: id, name: entry.name, before, after: { brains, adjudicate, editSources } },
      (file) => {
        const target = file.tokens.find((t) => t.id === id);
        if (!target || target.revokedAt !== null) {
          throw new TokenNotFoundError(`no active token ${id}`);
        }
        target.brains = brains;
        target.adjudicate = adjudicate;
        target.editSources = editSources;
      },
    );
    return toRecord(this.#requireActive(id));
  }

  /** Idempotent: revoking a revoked token answers success. Never undone. */
  async revoke(id: string, by: string): Promise<TokenRecord> {
    assertTokenId(id);
    const entry = this.#file.tokens.find((t) => t.id === id);
    if (!entry) throw new TokenNotFoundError(`no token ${id}`);
    if (entry.revokedAt !== null) return toRecord(entry);
    await this.#commit(
      "token.revoke",
      { token_id: id, name: entry.name },
      (file) => {
        const target = file.tokens.find((t) => t.id === id);
        if (!target || target.revokedAt !== null) {
          throw new TokenNotFoundError(`no active token ${id}`);
        }
        target.revokedAt = this.#now();
        target.revokedBy = by;
      },
    );
    // the committed row, not the pre-commit lookup object
    const committed = this.#file.tokens.find((t) => t.id === id);
    if (!committed) throw new TokenNotFoundError(`no token ${id}`);
    return toRecord(committed);
  }

  /** Release the lock on a clean shutdown — only if it is still ours. */
  dispose(): void {
    if (this.#lockPath !== null) {
      const holder = readHolder(this.#lockPath);
      if (holder?.pid === process.pid && holder.nonce === this.#lockNonce) {
        try {
          unlinkSync(this.#lockPath);
        } catch {
          // already gone
        }
      }
      this.#lockPath = null;
      this.#lockNonce = null;
    }
  }

  // --- internals ---------------------------------------------------------------

  #known(): Set<string> {
    return this.#deps.knownBrains?.() ?? new Set<string>();
  }

  #now(): string {
    return (this.#deps.now ?? (() => new Date().toISOString()))();
  }

  #requireActive(id: string): TokenEntry {
    assertTokenId(id);
    const entry = this.#file.tokens.find((t) => t.id === id);
    if (!entry) throw new TokenNotFoundError(`no token ${id}`);
    if (entry.revokedAt !== null) {
      throw new TokenNotFoundError(`token ${id} is revoked — issue a new one`);
    }
    return entry;
  }

  #rebuild(): void {
    const byHash = new Map<string, TokenEntry>();
    for (const t of this.#file.tokens) {
      if (t.revokedAt === null) byHash.set(t.hash, t);
    }
    this.#byHash = byHash;
  }

  #touch(entry: TokenEntry): void {
    const wall = Date.now();
    const previous = entry.lastUsedAt === null ? 0 : Date.parse(entry.lastUsedAt);
    if (!Number.isFinite(previous) || wall - previous >= LAST_USED_MIN_DELTA_MS) {
      entry.lastUsedAt = this.#now();
    }
    if (wall - this.#lastUsedPersist >= LAST_USED_PERSIST_MS) {
      this.#lastUsedPersist = wall;
      // The snapshot is taken INSIDE the mutex. A commit parks on its audit
      // write, so a snapshot taken out here could be older than a revoke
      // that is mid-flight — and persisting it afterwards would write the
      // revoked token back as active on disk, silently.
      void this.#serialize(() => {
        try {
          this.#persist(structuredClone(this.#file));
        } catch (err) {
          console.warn(`[tokens] last-used stamps not persisted: ${(err as Error).message}`);
        }
      });
    }
  }

  /** One mutex over every mutation (the last-used stamp included). */
  #serialize<T>(run: () => Promise<T> | T): Promise<T> {
    const next = this.#chain.then(run, run);
    this.#chain = next.catch(() => undefined);
    return next;
  }

  async #commit(
    action: string,
    detail: Record<string, unknown>,
    apply: (file: RegistryFile) => void,
    opts: { mayGrow?: boolean } = {},
  ): Promise<void> {
    return this.#serialize(async () => {
      const next = structuredClone(this.#file);
      apply(next); // validation may throw — nothing has touched disk yet
      assertInvariants(next);
      pruneTombstones(next);
      if (
        opts.mayGrow === true &&
        Buffer.byteLength(serialize(next), "utf8") > MAX_FILE_BYTES
      ) {
        throw new TokenValidationError(
          `the registry file is at its ${MAX_FILE_BYTES >> 10} KB cap — it cannot take another token`,
        );
      }
      const auditStrict = this.#deps.auditStrict;
      if (auditStrict) await auditStrict(action, detail);
      try {
        this.#persist(next);
      } catch (err) {
        const auditSoft = this.#deps.auditSoft;
        if (auditSoft) {
          await auditSoft(`${action}.failed`, {
            ...detail,
            error: (err as Error).message,
          }).catch(() => undefined);
        }
        throw new TokenRegistryError(
          `the token registry could not be written — nothing changed: ${(err as Error).message}`,
        );
      }
      this.#file = next;
      this.#rebuild();
    });
  }

  #persist(next: RegistryFile): void {
    // A hand edit underneath a running server makes our view stale; refuse
    // rather than overwrite it (restart after hand edits, or use the API).
    const st = statSync(this.path);
    // belt to the lock's braces: if the lock is no longer ours, another
    // instance holds this registry — a write now could undo its revocations
    const holder = this.#lockPath === null ? null : readHolder(this.#lockPath);
    if (holder?.pid !== process.pid || holder.nonce !== this.#lockNonce) {
      throw new Error(
        "this server no longer holds the token registry lock — refusing to write; restart cockpit",
      );
    }
    if (st.ino !== this.#ino || st.mtimeMs !== this.#mtimeMs || st.size !== this.#size) {
      throw new Error(
        "the registry file changed underneath the running server — restart cockpit instead of editing it by hand",
      );
    }
    const dir = dirname(this.path);
    const base = this.path.slice(dir.length + 1);
    const tmp = `${dir}/.${base}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    let fd: number | null = null;
    try {
      fd = openSync(tmp, "wx", 0o600);
      writeAll(fd, serialize(next));
      fsyncSync(fd);
      closeSync(fd);
      fd = null;
      renameSync(tmp, this.path); // the commit point
    } catch (err) {
      if (fd !== null) closeSync(fd);
      try {
        unlinkSync(tmp);
      } catch {
        // nothing to clean
      }
      throw err;
    }
    try {
      const dirFd = openSync(dir, fsConstants.O_RDONLY);
      try {
        fsyncSync(dirFd);
      } finally {
        closeSync(dirFd);
      }
    } catch (err) {
      // the rename already committed; durability of the directory entry is advisory
      console.warn(`[tokens] registry directory fsync failed: ${(err as Error).message}`);
    }
    const after = statSync(this.path);
    this.#ino = after.ino;
    this.#mtimeMs = after.mtimeMs;
    this.#size = after.size;
  }

  /**
   * One server per registry. The lock is a file beside the registry holding
   * "<pid> <nonce>", created exclusively; a live pid refuses us, a dead one
   * is taken over. Two starters racing are kept apart by three rules: a
   * lock that exists but is still empty is "being written" and gets a grace
   * period instead of a takeover; a takeover happens only under a second,
   * short-lived exclusive file; and every creation is read back to confirm
   * the content is ours.
   */
  #acquireLock(): void {
    const lockPath = `${this.path}.lock`;
    const mutexPath = `${lockPath}.takeover`;
    const nonce = randomBytes(8).toString("hex");
    const self = `${process.pid} ${nonce}`;
    const grace = this.#deps.lockGraceMs ?? LOCK_GRACE_MS;
    const deadline =
      Date.now() + Math.max(this.#deps.lockWaitMs ?? LOCK_WAIT_MS, grace + 1_000);

    const mine = (): boolean => {
      const holder = readHolder(lockPath);
      return holder?.pid === process.pid && holder.nonce === nonce;
    };
    const heldByOther = (holder: { pid: number } | null): ConfigError | null => {
      if (holder === null) return null;
      if (holder.pid === process.pid) {
        return new ConfigError(
          "this process already holds the token registry lock",
          "load the registry once per process.",
        );
      }
      if (isAlive(holder.pid)) {
        return new ConfigError(
          `another cockpit (pid ${holder.pid}) is already using the token registry`,
          "one server per registry file — its revocations would be undone by the other instance's next write. Stop that instance first.",
        );
      }
      return null;
    };
    /** create + write + read back; false when the file already exists */
    const tryCreate = (): boolean => {
      let fd: number | null = null;
      try {
        fd = openSync(lockPath, "wx", 0o600);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
          throw new ConfigError(
            `cannot create the token registry lock: ${lockPath}`,
            `check the directory's permissions (${(err as Error).message}).`,
          );
        }
        return false;
      }
      try {
        writeAll(fd, self);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      if (mine()) {
        this.#lockPath = lockPath;
        this.#lockNonce = nonce;
        return true;
      }
      throw new ConfigError(
        "the token registry lock changed hands while it was being created",
        "another cockpit is starting on the same registry — start one at a time.",
      );
    };

    for (;;) {
      if (tryCreate()) return;
      const now = Date.now();
      const holder = readHolder(lockPath);
      if (holder !== null) {
        const refusal = heldByOther(holder);
        if (refusal) throw refusal;
      } else {
        let st;
        try {
          st = lstatSync(lockPath);
        } catch {
          continue; // vanished between the two calls — go round and create
        }
        if (now - st.mtimeMs < grace) {
          // empty or unreadable and fresh: its creator is most likely still
          // writing it — judging it stale now is how two starters both win
          if (now > deadline) {
            throw new ConfigError(
              `the token registry lock is unreadable: ${lockPath}`,
              "remove the lock file by hand if no other cockpit is running.",
            );
          }
          sleepSync(25);
          continue;
        }
      }
      // stale: a dead holder, or nothing written past the grace period
      let mutexFd: number | null = null;
      try {
        mutexFd = openSync(mutexPath, "wx", 0o600);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
          throw new ConfigError(
            `cannot create the token registry takeover guard: ${mutexPath}`,
            `check the directory's permissions (${(err as Error).message}).`,
          );
        }
        // someone else is taking over; a guard older than the grace period
        // belonged to a taker that died — clear it and try again
        try {
          const guard = lstatSync(mutexPath);
          if (now - guard.mtimeMs > grace) unlinkSync(mutexPath);
        } catch {
          // gone already
        }
        if (now > deadline) {
          throw new ConfigError(
            `cannot lock the token registry: ${lockPath}`,
            "another cockpit may be starting on it — wait a moment, or remove the lock files by hand if none is running.",
          );
        }
        sleepSync(25);
        continue;
      }
      try {
        // re-judge under the guard: a fellow starter may already have
        // replaced the stale lock with a live one
        const again = readHolder(lockPath);
        const refusal = heldByOther(again);
        if (refusal) throw refusal;
        try {
          unlinkSync(lockPath);
        } catch {
          // already gone
        }
        if (tryCreate()) return;
      } finally {
        closeSync(mutexFd);
        try {
          unlinkSync(mutexPath);
        } catch {
          // nothing to clean
        }
      }
    }
  }
}

// --- loading helpers -------------------------------------------------------------

function readRegistryFile(file: string): {
  text: string;
  stat: { ino: number; mtimeMs: number; size: number };
} {
  let st;
  try {
    st = lstatSync(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ConfigError(
        `COCKPIT_TOKENS_FILE is set but the file does not exist: ${file}`,
        `create it as the service user — a missing file is never treated as "empty":\n  printf '{"version":1,"tokens":[]}\\n' > ${file} && chmod 600 ${file}`,
      );
    }
    throw new ConfigError(
      `COCKPIT_TOKENS_FILE is unreadable: ${file}`,
      "check the path and permissions — the file must belong to the service user with mode 600.",
    );
  }
  if (st.isSymbolicLink()) {
    throw new ConfigError(
      `COCKPIT_TOKENS_FILE must not be a symbolic link: ${file}`,
      "point the env var at the real file.",
    );
  }
  if (!st.isFile()) {
    throw new ConfigError(
      `COCKPIT_TOKENS_FILE is not a regular file: ${file}`,
      "the registry is one JSON file.",
    );
  }
  assertDirChain(dirname(file));
  // Open with O_NOFOLLOW and check the opened inode (not the path): what we
  // validate is exactly what we read, even if the path is swapped in between.
  let fd: number;
  try {
    fd = openSync(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (err) {
    throw new ConfigError(
      `COCKPIT_TOKENS_FILE cannot be opened: ${file}`,
      `check its permissions (${(err as Error).message}).`,
    );
  }
  try {
    const fst = fstatSync(fd);
    if (!fst.isFile()) {
      throw new ConfigError(
        `COCKPIT_TOKENS_FILE is not a regular file: ${file}`,
        "the registry is one JSON file.",
      );
    }
    const me = typeof process.getuid === "function" ? process.getuid() : undefined;
    if (me !== undefined && fst.uid !== 0 && fst.uid !== me) {
      throw new ConfigError(
        `COCKPIT_TOKENS_FILE is owned by another user (uid ${fst.uid}): ${file}`,
        `chown it to the service user:\n  sudo chown <service-user> ${file}`,
      );
    }
    if ((fst.mode & 0o022) !== 0) {
      throw new ConfigError(
        `COCKPIT_TOKENS_FILE is writable by group or others (mode ${octal(fst.mode)}): ${file}`,
        `anyone could drop in a fully-granted token:\n  chmod 600 ${file}`,
      );
    }
    if ((fst.mode & 0o077) !== 0) {
      console.warn(
        `[tokens] registry is readable by group/others (mode ${octal(fst.mode)}) — chmod 600 ${file}`,
      );
    }
    if (fst.size > HARD_FILE_BYTES) {
      throw new ConfigError(
        `COCKPIT_TOKENS_FILE exceeds ${HARD_FILE_BYTES} bytes: ${file}`,
        "this is not a registry cockpit wrote — check the path (a runaway or hand-made file).",
      );
    }
    if (fst.size > MAX_FILE_BYTES) {
      console.warn(
        `[tokens] registry is ${fst.size} bytes (soft cap ${MAX_FILE_BYTES}) — issuing stops at the cap; old revoked rows are pruned on the next write`,
      );
    }
    return {
      text: readFileSync(fd, "utf8"),
      stat: { ino: fst.ino, mtimeMs: fst.mtimeMs, size: fst.size },
    };
  } finally {
    closeSync(fd);
  }
}

/** Nobody but the service user (and root) may write any directory on the
 *  way down: write access to the directory = write access to the registry. */
function assertDirChain(dir: string): void {
  let current: string;
  try {
    current = realpathSync(dir);
  } catch {
    throw new ConfigError(
      `COCKPIT_TOKENS_FILE's directory does not exist: ${dir}`,
      "create it first, as the service user.",
    );
  }
  const me = typeof process.getuid === "function" ? process.getuid() : undefined;
  for (let guard = 0; guard < 64; guard++) {
    const st = lstatSync(current);
    if (st.uid === 0) break; // root-maintained from here up
    const worldWritable = (st.mode & 0o002) !== 0;
    // same rule as the file itself: nobody else may write. (A root-owned
    // sticky /tmp is never reached — the walk stops at root-owned dirs.)
    const unsafe =
      (st.mode & 0o022) !== 0 || // writable by group or others
      (me !== undefined && st.uid !== me); // someone else's directory
    if (unsafe) {
      throw new ConfigError(
        `directory ${current} is writable by others (or not the service user's) — the token registry could be swapped`,
        `close it:\n  chmod go-w ${current}`,
      );
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

function parseRegistry(text: string, known: Set<string>): RegistryFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("not JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("the top level must be an object");
  }
  const o = parsed as Record<string, unknown>;
  for (const key of Object.keys(o)) {
    if (key !== "version" && key !== "tokens") {
      throw new Error(`unknown top-level field: ${printableKey(key)}`);
    }
  }
  if (o.version !== 1) throw new Error("version must be 1");
  if (!Array.isArray(o.tokens)) throw new Error("tokens must be an array");
  const tokens = o.tokens.map((raw, i) => parseEntry(raw, i, known));
  const ids = new Set<string>();
  const skeletons = new Set<string>();
  for (const t of tokens) {
    if (ids.has(t.id)) throw new Error(`duplicate token id ${t.id}`);
    ids.add(t.id);
    if (t.revokedAt === null) {
      const skeleton = nameSkeleton(t.name);
      if (skeletons.has(skeleton)) {
        throw new Error(`two active tokens share the name "${t.name}"`);
      }
      skeletons.add(skeleton);
    }
  }
  return { version: 1, tokens };
}

function parseEntry(raw: unknown, i: number, known: Set<string>): TokenEntry {
  const where = `tokens[${i}]`;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${where} must be an object`);
  }
  const o = raw as Record<string, unknown>;
  for (const key of Object.keys(o)) {
    if (!(ENTRY_KEYS as readonly string[]).includes(key)) {
      throw new Error(`${where} has an unknown field ${printableKey(key)}`);
    }
  }
  for (const key of ENTRY_KEYS) {
    if (!(key in o)) throw new Error(`${where} is missing "${key}"`);
  }
  if (typeof o.id !== "string" || !ID_RE.test(o.id)) {
    throw new Error(`${where}.id is malformed`);
  }
  const name = normalizeTokenName(o.name);
  if (name === null || name !== o.name) {
    throw new Error(`${where}.name is not in canonical form`);
  }
  if (isReservedTokenName(name)) {
    throw new Error(`${where}.name uses a reserved word`);
  }
  if (typeof o.hash !== "string" || !HASH_RE.test(o.hash)) {
    throw new Error(`${where}.hash is malformed`);
  }
  const where2 = `${where} (${name})`;
  if (!Array.isArray(o.brains) || o.brains.length === 0) {
    throw new Error(`${where2}: brains must list at least one brain`);
  }
  const brains: string[] = [];
  for (const b of o.brains) {
    if (typeof b !== "string" || !PROFILE_ID_RE.test(b)) {
      throw new Error(`${where2}: invalid brain id`);
    }
    if (!brains.includes(b)) brains.push(b);
    if (!known.has(b)) {
      console.warn(
        `[tokens] token "${name}" names brain "${b}", which is not in brains.json — requests for it answer 403`,
      );
    }
  }
  if (typeof o.adjudicate !== "boolean") {
    throw new Error(`${where2}: adjudicate must be true or false`);
  }
  if (!Array.isArray(o.editSources)) {
    throw new Error(`${where2}: editSources must be an array`);
  }
  const editSources: string[] = [];
  for (const s of o.editSources) {
    if (typeof s !== "string" || !isValidSourceId(s)) {
      throw new Error(`${where2}: invalid source id in editSources`);
    }
    if (!editSources.includes(s)) editSources.push(s);
  }
  // While edit grants are closed the sheet must not carry any — the
  // management API refuses them, so a non-empty list here is a hand edit
  // trying to switch the route-level gate open.
  if (editSources.length > 0 && !EDIT_GRANTS_OPEN) {
    throw new Error(`${where2}: editSources must be empty until edit grants open`);
  }
  const { createdAt, createdBy, revokedAt, revokedBy, lastUsedAt } = o;
  if (typeof createdAt !== "string" || !createdAt) {
    throw new Error(`${where2}: createdAt must be a non-empty string`);
  }
  if (typeof createdBy !== "string" || !createdBy) {
    throw new Error(`${where2}: createdBy must be a non-empty string`);
  }
  const revoked = revokedAt !== null || revokedBy !== null;
  if (
    (revokedAt !== null && typeof revokedAt !== "string") ||
    (revokedBy !== null && typeof revokedBy !== "string") ||
    (revokedAt === null) !== (revokedBy === null)
  ) {
    throw new Error(`${where2}: revokedAt and revokedBy go together`);
  }
  if (lastUsedAt !== null && typeof lastUsedAt !== "string") {
    throw new Error(`${where2}: lastUsedAt must be a timestamp or null`);
  }
  return {
    id: o.id,
    name,
    hash: o.hash,
    brains,
    adjudicate: o.adjudicate,
    editSources,
    createdAt,
    createdBy,
    revokedAt,
    revokedBy,
    lastUsedAt,
  };
}

function assertInvariants(file: RegistryFile): void {
  const ids = new Set<string>();
  const skeletons = new Set<string>();
  for (const t of file.tokens) {
    if (ids.has(t.id)) throw new TokenRegistryError(`duplicate token id ${t.id}`);
    ids.add(t.id);
    if (t.revokedAt === null) {
      const skeleton = nameSkeleton(t.name);
      if (skeletons.has(skeleton)) {
        throw new TokenValidationError(
          `an active token named "${t.name}" already exists — names must not be confusable`,
        );
      }
      skeletons.add(skeleton);
    }
  }
}

// --- request-field parsers (400 on anything outside the contract) --------------

function parseBrains(raw: unknown, known: Set<string>): string[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new TokenValidationError("brains must list at least one brain profile");
  }
  const out: string[] = [];
  for (const b of raw) {
    if (typeof b !== "string" || !PROFILE_ID_RE.test(b)) {
      throw new TokenValidationError("brains must be brain profile ids");
    }
    if (!known.has(b)) {
      throw new TokenValidationError(`unknown brain profile: ${b}`);
    }
    if (!out.includes(b)) out.push(b);
  }
  return out;
}

function parseEditSources(raw: unknown): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    throw new TokenValidationError("editSources must be an array of source ids");
  }
  const out: string[] = [];
  for (const s of raw) {
    if (typeof s !== "string" || !isValidSourceId(s)) {
      throw new TokenValidationError("editSources must be source ids");
    }
    if (!out.includes(s)) out.push(s);
  }
  if (out.length > 0 && !EDIT_GRANTS_OPEN) {
    throw new TokenValidationError(
      "edit grants are not open yet — the per-source write channel arrives in the next step",
    );
  }
  return out;
}

function parseBoolean(raw: unknown, field: string): boolean {
  if (typeof raw !== "boolean") {
    throw new TokenValidationError(`${field} must be true or false`);
  }
  return raw;
}

function sheetOf(entry: TokenEntry): GrantSheet {
  return {
    brains: entry.brains,
    adjudicate: entry.adjudicate,
    editSources: entry.editSources,
  };
}

function toRecord(entry: TokenEntry): TokenRecord {
  return {
    id: entry.id,
    name: entry.name,
    brains: [...entry.brains],
    adjudicate: entry.adjudicate,
    editSources: [...entry.editSources],
    createdAt: entry.createdAt,
    createdBy: entry.createdBy,
    revokedAt: entry.revokedAt,
    revokedBy: entry.revokedBy,
    lastUsedAt: entry.lastUsedAt,
  };
}

function serialize(file: RegistryFile): string {
  return `${JSON.stringify(file, null, 2)}\n`;
}

/** Drop revoked rows that are past their keep window. */
function pruneTombstones(file: RegistryFile): void {
  const cutoff = Date.now() - TOMBSTONE_MS;
  file.tokens = file.tokens.filter((t) => {
    if (t.revokedAt === null) return true;
    const at = Date.parse(t.revokedAt);
    return !Number.isFinite(at) || at >= cutoff;
  });
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function octal(mode: number): string {
  return (mode & 0o7777).toString(8).padStart(4, "0");
}

/** What a lock file says: "<pid> <nonce>". Null when it is empty, unreadable
 *  or not in that shape — i.e. still being written, or torn. */
function readHolder(lockPath: string): { pid: number; nonce: string | null } | null {
  try {
    const text = readFileSync(lockPath, "utf8").trim();
    if (text === "") return null;
    const [pidRaw, nonce] = text.split(/\s+/);
    const pid = Number.parseInt(pidRaw ?? "", 10);
    if (!Number.isInteger(pid) || pid <= 0) return null;
    return { pid, nonce: nonce ?? null };
  } catch {
    return null;
  }
}

/** A key name from the file, as the boot error may print it: quoted, bounded
 *  and with control characters escaped (it is untrusted input). */
function printableKey(key: string): string {
  return JSON.stringify(key).slice(0, 64) + (key.length > 60 ? "…" : "");
}

function assertTokenId(id: string): void {
  if (!ID_RE.test(id)) {
    throw new TokenValidationError("id must be a token id (tk_ plus 12 hex digits)");
  }
}

/** write(2) may write less than asked (a full disk) without failing — loop. */
function writeAll(fd: number, text: string): void {
  const buf = Buffer.from(text, "utf8");
  let offset = 0;
  while (offset < buf.length) {
    const written = writeSync(fd, buf, offset, buf.length - offset);
    if (written <= 0) throw new Error("could not write the registry (zero-length write)");
    offset += written;
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** `kill(pid, 0)` throws ESRCH when the pid is gone; EPERM means alive. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The file a fresh deployment starts from (also printed in the boot hint). */
export const EMPTY_REGISTRY_TEXT = '{"version":1,"tokens":[]}\n';
