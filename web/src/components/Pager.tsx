import { useCallback, useState } from "react";
import { useI18n } from "../lib/i18n";

// Shared pager: prev/next + page indicator + a page-size selector (owner
// feedback: a fixed 50-per-page render is too dense to scan). The chosen
// size persists per surface (inbox / pages) in localStorage.

export const PAGE_SIZES = [10, 25, 50, 100] as const;
const DEFAULT_SIZE = 10;

/** persisted, whitelist-checked page size for one surface */
export function usePageSize(storageKey: string): [number, (next: number) => void] {
  const [size, setSize] = useState<number>(() => {
    const stored = Number(localStorage.getItem(storageKey));
    return (PAGE_SIZES as readonly number[]).includes(stored) ? stored : DEFAULT_SIZE;
  });
  const set = useCallback(
    (next: number) => {
      setSize(next);
      try {
        localStorage.setItem(storageKey, String(next));
      } catch {
        // storage blocked — the choice just won't persist
      }
    },
    [storageKey],
  );
  return [size, set];
}

export function Pager({
  page,
  totalPages,
  size,
  onPage,
  onSize,
}: {
  /** 0-based current page */
  page: number;
  totalPages: number;
  size: number;
  onPage: (next: number) => void;
  onSize: (next: number) => void;
}) {
  const { t } = useI18n();
  return (
    <span className="pager">
      <button
        type="button"
        disabled={page <= 0}
        onClick={() => onPage(page - 1)}
        aria-label={t("pager.prev")}
      >
        ←
      </button>
      <span className="mono">
        {page + 1}/{totalPages}
      </span>
      <button
        type="button"
        disabled={page >= totalPages - 1}
        onClick={() => onPage(page + 1)}
        aria-label={t("pager.next")}
      >
        →
      </button>
      <select
        className="pager-size mono"
        value={size}
        aria-label={t("pager.size")}
        onChange={(e) => onSize(Number(e.target.value))}
      >
        {PAGE_SIZES.map((n) => (
          <option key={n} value={n}>
            {n}
          </option>
        ))}
      </select>
    </span>
  );
}
