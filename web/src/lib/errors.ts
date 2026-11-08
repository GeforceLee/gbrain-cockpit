import type { MessageKey } from "./i18n";
import { ApiError } from "./api";

// Error-code → user-language copy (ARCHITECTURE §7: the map is sourced from
// shared's error-code constants; the raw server message stays available as
// detail). Codes without a locale key fall back to the raw message — never
// to a blank or a lie.

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
    const key = `error.${err.code}` as MessageKey;
    const mapped = t(key);
    if (mapped !== key) {
      const raw = err.message ?? "";
      // the envelope's message is often the code's own English text — keep
      // the display line clean when the detail adds nothing
      return mapped === raw ? mapped : `${mapped} · ${raw}`;
    }
  }
  return err instanceof Error ? err.message : String(err);
}
