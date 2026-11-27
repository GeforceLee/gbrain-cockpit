import { useSyncExternalStore } from "react";
import type { MeResponse } from "@gbrain-cockpit/shared";

// Who is calling (0.7 named tokens) — a module-level external store, the
// brain.ts / auditLog.ts precedent. lib/api and lib/brain read it
// synchronously; every panel's "show or hide" derives from it, never from
// guesses. The owner's two env tokens answer kind "owner" and hold every
// permission; a named token's answer is its grant sheet.

export interface MeState {
  /** true once GET /api/me answered for the stored token */
  loaded: boolean;
  me: MeResponse | null;
}

let state: MeState = { loaded: false, me: null };

const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function getMe(): MeResponse | null {
  return state.me;
}

export function getMeState(): MeState {
  return state;
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function useMe(): MeState {
  return useSyncExternalStore(subscribe, getMeState);
}

export function setMe(me: MeResponse | null): void {
  state = { loaded: me !== null, me };
  emit();
}

/**
 * WHO is calling, as /api/me answered it. "unknown" is its own state: the
 * call failed for a reason other than a dead token (offline, a 5xx). The UI
 * then shows the least it can — it must not fall back to the owner's desks
 * merely because a request timed out. Only an explicit "owner" is an owner.
 */
export type Role = "owner" | "named" | "unknown";

export function role(): Role {
  const me = state.me;
  if (me === null) return "unknown";
  return me.kind === "owner" ? "owner" : "named";
}

/** The owner's env tokens: everything the 0.6 UI showed is theirs. */
export function isOwner(): boolean {
  return role() === "owner";
}

export function isNamedToken(): boolean {
  return role() === "named";
}

export function canAdjudicate(): boolean {
  return state.me?.permissions.adjudicate === true;
}

/** The paid deep answer: only where the sheet says so (the owner's always). */
export function hasPaidThink(): boolean {
  return state.me?.permissions.paidThink === true;
}

/** May this caller save pages in that source (step 2 wires the channel). */
export function canEditSource(source: string | undefined): boolean {
  const me = state.me;
  if (!me) return false;
  if (me.kind === "owner") return true;
  const id = source ?? "default";
  return me.permissions.editSources !== "all" && me.permissions.editSources.includes(id);
}
