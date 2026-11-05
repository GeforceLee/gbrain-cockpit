import { useEffect, useRef, useState } from "react";
import type { PageDetail, PageVersion } from "@gbrain-cockpit/shared";
import { ApiError, apiGet } from "./api";

// The one page-detail data path every surface shares (Pages panel, Nebula
// drawer peek, the shared PageDrawer): one fetch shape, one endpoint.

/** GET /api/page payload. */
export interface PageBundle {
  page: PageDetail;
  versions: PageVersion[];
}

/**
 * Same shape as the server route's SLUG_RE (server/src/routes/api.ts) — a
 * client-side pre-check for "is this queue-card target a peekable page
 * slug"; the server re-validates regardless (defense in depth).
 */
export function isSlugLike(value: string | undefined | null): value is string {
  return !!value && /^[a-zA-Z0-9][a-zA-Z0-9/_.-]{0,200}$/.test(value);
}

/**
 * Fetch a page bundle by slug with a sequence guard: rapid re-selection can
 * only ever land the LAST slug — late responses are dropped. `null` is idle
 * (no request). Extracted from the Nebula drawer peek when the same pattern
 * was needed a third time.
 */
export function usePageBundle(slug: string | null) {
  const [bundle, setBundle] = useState<PageBundle | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const seq = useRef(0);

  useEffect(() => {
    const mine = ++seq.current;
    setBundle(null);
    setError(null);
    setLoading(slug !== null);
    if (!slug) return;
    apiGet<PageBundle>(`/api/page?slug=${encodeURIComponent(slug)}`)
      .then((next) => {
        if (seq.current !== mine) return;
        setBundle(next);
      })
      .catch((err) => {
        if (seq.current !== mine) return;
        setError(err instanceof ApiError ? err.message : String(err));
      })
      .finally(() => {
        if (seq.current !== mine) return;
        setLoading(false);
      });
  }, [slug]);

  return { bundle, error, loading };
}
