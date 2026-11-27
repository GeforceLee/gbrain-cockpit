import type { PermissionMissing } from "@gbrain-cockpit/shared";
import type { MessageKey } from "./i18n";
import { ApiError } from "./api";
import { forbiddenMessage } from "./forbidden";

export { forbiddenMessage } from "./forbidden";

// Error-code → user-language copy (ARCHITECTURE §7: the map is sourced from
// shared's error-code constants; the raw server message stays available as
// detail). Codes without a locale key fall back to the raw message — never
// to a blank or a lie.
//
// 0.7: a 403 that names the missing grant gets its own plain line ("your
// token has no adjudicate grant"), and the classes nobody can be given read
// "admin only" — not "you lack X", which would sound requestable.

/**
 * The bilingual line for an error. Unknown codes and non-ApiError failures
 * return the raw message; a mapped code returns its locale line and appends
 * the server's own words as detail when they add anything.
 */
export function errorMessage(
  err: unknown,
  t: (key: MessageKey) => string,
): string {
  if (err instanceof ApiError) {
    if (err.status === 403 && err.extra.missing) {
      return forbiddenMessage(err.extra.missing, err.extra.source, t);
    }
    const key = `error.${err.code}` as MessageKey;
    const mapped = t(key);
    if (mapped !== key) {
      const raw = err.extra.raw ?? err.message ?? "";
      // the envelope's message is often the code's own English text — keep
      // the display line clean when the detail adds nothing
      return mapped === raw ? mapped : `${mapped} · ${raw}`;
    }
  }
  return err instanceof Error ? err.message : String(err);
}


/**
 * The line for a FAILED management action (a pasted admin token): a wrong
 * or non-admin token is that action's own mistake — it must never read as
 * "your session expired", which would send the owner off to re-login.
 */
export function stepUpErrorMessage(
  err: unknown,
  t: (key: MessageKey) => string,
): string {
  if (err instanceof ApiError && err.status === 401) return t("admin.stepUp.invalid");
  // a base token pasted where the admin token belongs arrives as a 403 with
  // the structured "admin-tier" marker — errorMessage already says so
  return errorMessage(err, t);
}
