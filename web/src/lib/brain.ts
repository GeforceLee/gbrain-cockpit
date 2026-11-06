// Brain profile store — which gbrain deployment every API call targets.
//
// A module-level external store (the auditLog precedent) rather than React
// context: lib/api.ts must read the current id synchronously on every
// fetch, and a context would force a circular import. The store talks to
// the server with a bare fetch + getToken() for the same reason.
//
// One cockpit token gates every profile (V1 single-token decision) —
// switching profiles switches the BRAIN, never the operator.

import { useSyncExternalStore } from "react";
import type { ProfileInfo, ProfilesResponse } from "@gbrain-cockpit/shared";
import { getToken } from "./token";

const PROFILE_KEY = "cockpit.profile";

interface BrainState {
  /** false until the first GET /api/profiles resolves (or fails → fallback) */
  loaded: boolean;
  profiles: ProfileInfo[];
  defaultId: string;
  currentId: string;
  /** one-line notice when the persisted profile vanished server-side */
  notice: string | null;
}

let state: BrainState = {
  loaded: false,
  profiles: [{ id: "default", name: "gbrain" }],
  defaultId: "default",
  currentId: "default",
  notice: null,
};

const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function setState(patch: Partial<BrainState>): void {
  state = { ...state, ...patch };
  emit();
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

/**
 * Fetch the profile list once after auth. On failure, fall back to a single
 * implicit profile so the UI never blocks — the header is simply omitted
 * and the server routes to its default.
 */
export async function bootstrapProfiles(): Promise<void> {
  let body: ProfilesResponse | null = null;
  const token = getToken();
  if (token) {
    try {
      const res = await fetch("/api/profiles", {
        headers: { authorization: `Bearer ${token}` },
      });
      if (res.ok) body = (await res.json()) as ProfilesResponse;
    } catch {
      // network error — same fallback as a non-OK response
    }
  }
  if (!body || !Array.isArray(body.profiles) || body.profiles.length === 0) {
    setState({
      loaded: true,
      profiles: [{ id: "default", name: "gbrain" }],
      defaultId: "default",
      currentId: "default",
    });
    return;
  }
  const profiles = body.profiles;
  const defaultId = body.defaultId || profiles[0]!.id;
  const stored = (() => {
    try {
      return localStorage.getItem(PROFILE_KEY);
    } catch {
      return null;
    }
  })();
  const currentId = profiles.some((p) => p.id === stored)
    ? (stored as string)
    : defaultId;
  setState({ loaded: true, profiles, defaultId, currentId, notice: null });
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
  setState({
    notice: "saved brain profile no longer exists — switched back to the default",
  });
}

export function clearBrainNotice(): void {
  if (state.notice !== null) setState({ notice: null });
}
