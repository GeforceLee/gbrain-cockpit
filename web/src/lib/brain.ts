// Brain profile store — which gbrain deployment every API call targets.
//
// A module-level external store (the auditLog precedent) rather than React
// context: lib/api.ts must read the current id synchronously on every
// fetch, and a context would force a circular import. The store talks to
// the server with a bare fetch + getToken() for the same reason. Its one
// lib/api import, withBase, is a pure path-prefix helper referenced only
// at fetch time — no module-eval-time coupling either way, so the edge is
// load-safe.
//
// 0.7 (named tokens): WHO is calling now bounds WHICH brains are listed —
// a named token sees only the brains on its sheet. And a named token's
// browser ALWAYS names the brain in the request header: its sheet can
// change mid-session, so an implicit "default brain" would send a click to
// a brain the person is not looking at. The server's header-less rule
// (first brain on the sheet) is for curl and scripts.

import { useSyncExternalStore } from "react";
import type { MeResponse, ProfileInfo, ProfilesResponse } from "@gbrain-cockpit/shared";
import { getToken } from "./token";
import { withBase, expireSession } from "./api";
import { setMe } from "./me";

const PROFILE_KEY = "cockpit.profile";

export type BrainNoticeKind = "unknown" | "denied" | null;

interface BrainState {
  /** false until the session boot resolves (or fails → fallback) */
  loaded: boolean;
  /**
   * Deployment capability (server's COCKPIT_ADMIN_TOKEN configured?), from
   * the same profiles fetch — gates the Admin panel's visibility. Fails
   * CLOSED: the fallback path and a lost fetch both hide the panel; the
   * server enforces the tier regardless of what the UI shows.
   */
  adminTier: boolean;
  profiles: ProfileInfo[];
  defaultId: string;
  currentId: string;
  /** a named token names the brain on every request, default or not */
  explicitHeader: boolean;
  /** why the active brain was switched out from under the user */
  notice: BrainNoticeKind;
}

const INITIAL: BrainState = {
  loaded: false,
  adminTier: false,
  profiles: [{ id: "default", name: "gbrain" }],
  defaultId: "default",
  currentId: "default",
  explicitHeader: false,
  notice: null,
};

let state: BrainState = INITIAL;

const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function setState(patch: Partial<BrainState>): void {
  state = { ...state, ...patch };
  emit();
}

function readStoredId(): string | null {
  try {
    return localStorage.getItem(PROFILE_KEY);
  } catch {
    return null;
  }
}

function persistCurrentId(): void {
  try {
    localStorage.setItem(PROFILE_KEY, state.currentId);
  } catch {
    // private mode / storage full — switching still works this session
  }
}

/** The id every request should carry; null means "default, header omitted". */
export function currentProfileId(): string | null {
  if (state.explicitHeader) return state.currentId || null;
  return state.currentId === state.defaultId ? null : state.currentId;
}

export function getBrainState(): BrainState {
  return state;
}

export function subscribeBrain(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function useBrain(): BrainState {
  return useSyncExternalStore(subscribeBrain, getBrainState);
}

/** The active profile's info (labels/cliCommand/readOnly). */
export function currentProfile(): ProfileInfo | undefined {
  return state.profiles.find((p) => p.id === state.currentId);
}

/** Forget the session's brain state entirely (sign-out, expired token). */
export function resetBrainState(): void {
  try {
    localStorage.removeItem(PROFILE_KEY);
  } catch {
    // no storage
  }
  state = INITIAL;
  emit();
}

/**
 * Session boot: who is calling, then which brains that caller may enter.
 * A 401 on either call ends the session (the token is invalid or revoked);
 * any other failure falls back to the 0.6 implicit single profile so the
 * UI never blocks.
 */
export async function bootstrapProfiles(): Promise<void> {
  const token = getToken();
  let me: MeResponse | null = null;
  if (token) {
    try {
      const meRes = await fetch(withBase("/api/me"), {
        headers: { authorization: `Bearer ${token}` },
      });
      if (meRes.status === 401) {
        expireSession();
        return;
      }
      if (meRes.ok) me = (await meRes.json()) as MeResponse;
    } catch {
      // network error — resolved below as "unknown caller"
    }
  }
  const named = me?.kind === "token";
  // An identity confirmed at sign-in (or by an earlier answer) survives a
  // transient failure here; null only when nothing ever answered.
  if (me) setMe(me);

  let body: ProfilesResponse | null = null;
  if (token) {
    try {
      const res = await fetch(withBase("/api/profiles"), {
        headers: { authorization: `Bearer ${token}` },
      });
      if (res.status === 401) {
        expireSession();
        return;
      }
      if (res.ok) body = (await res.json()) as ProfilesResponse;
    } catch {
      // network error — same fallback as a non-OK response
    }
  }
  if (me && !body) {
    // profiles call failed but identity resolved: keep what /api/me said
    setState({
      loaded: true,
      adminTier: false,
      explicitHeader: named,
      notice: null,
      profiles: named
        ? me.brains.map((id) => ({ id, name: id, canConfirm: false }))
        : [{ id: "default", name: "gbrain" }],
      defaultId: named ? (me.defaultBrain || me.brains[0] || "") : "default",
      currentId: named ? (me.defaultBrain || me.brains[0] || "") : "default",
    });
    return;
  }
  if (!body || !Array.isArray(body.profiles) || body.profiles.length === 0) {
    if (named) {
      // every brain on the sheet is gone from brains.json: say so — never
      // invent an implicit brain the token would then be refused for
      setState({
        loaded: true,
        adminTier: false,
        explicitHeader: true,
        notice: null,
        profiles: [],
        defaultId: "",
        currentId: "",
      });
      return;
    }
    setState({
      loaded: true,
      // explicit false: setState merges, a stale true from an earlier good
      // boot must not survive a degraded refetch (heal path)
      adminTier: false,
      explicitHeader: false,
      notice: null,
      profiles: [{ id: "default", name: "gbrain" }],
      defaultId: "default",
      currentId: "default",
    });
    return;
  }
  const profiles = body.profiles;
  const defaultId = body.defaultId || profiles[0]!.id;
  const stored = readStoredId();
  const currentId = profiles.some((p) => p.id === stored)
    ? (stored as string)
    : defaultId;
  setState({
    loaded: true,
    adminTier: named ? false : body.adminTier === true,
    // a named token always names its brain; while the identity is unresolved
    // the header is sent too (harmless for the env tokens, and a named token
    // must not become implicit just because /api/me timed out)
    explicitHeader: named || me === null,
    notice: null,
    profiles,
    defaultId,
    currentId,
  });
}

/** Switch the active brain; the App remounts the stage on this change. */
export function setProfile(id: string): void {
  if (!state.profiles.some((p) => p.id === id)) return;
  if (id === state.currentId) return;
  setState({ currentId: id, notice: null });
  persistCurrentId();
}

/**
 * Self-heal when the server rejects the persisted id (profile removed from
 * brains.json): refetch, fall back to the default, keep a one-line notice.
 */
export async function healAfterUnknownProfile(): Promise<void> {
  await bootstrapProfiles();
  setState({ notice: "unknown" });
}

/** The sheet stopped listing the brain being viewed: move to one it does. */
export async function healAfterBrainDenied(): Promise<void> {
  await bootstrapProfiles();
  setState({ notice: "denied" });
}

export function clearBrainNotice(): void {
  if (state.notice !== null) setState({ notice: null });
}
