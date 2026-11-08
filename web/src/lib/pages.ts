import { useEffect, useRef, useState } from "react";
import type {
  LinkRow,
  PageDetail,
  PageVersion,
  SearchHit,
  TimelineEntry,
} from "@gbrain-cockpit/shared";
import { ApiError, apiGet } from "./api";

// The one page-detail data path every surface shares (Pages panel, Nebula
// drawer peek, the shared PageDrawer): one fetch shape, one endpoint.

/** GET /api/page payload. The V1.1 provenance sections (links / backlinks /
 *  timeline) attach only on `full=1` requests; `degraded` names the sections
 *  that failed or are unsupported upstream — an old server's payload (no
 *  sections, no degraded) is indistinguishable from a degraded section, and
 *  every consumer renders that as "unavailable", never as an error. */
export interface PageBundle {
  page: PageDetail;
  versions: PageVersion[];
  links?: LinkRow[];
  backlinks?: LinkRow[];
  timeline?: TimelineEntry[];
  degraded?: string[];
}

/** A page address as surfaces pass it around: slug + the source when known. */
export interface PageRef {
  slug: string;
  /**
   * Page identity is (source_id, slug): with same-slug pages in two sources
   * a bare slug is resolved SILENTLY server-side — every caller that knows
   * the source (list rows, search hits, graph nodes) must carry it.
   */
  sourceId?: string;
}

/** PageRef → query string (source_id only when known — older servers ignore). */
export function pageRefQuery(ref: PageRef): string {
  const slug = `slug=${encodeURIComponent(ref.slug)}`;
  return ref.sourceId ? `${slug}&source_id=${encodeURIComponent(ref.sourceId)}` : slug;
}

/** Same-source equality for refs (slug alone matches when source unknown). */
export function samePage(a: PageRef, b: PageRef): boolean {
  return a.slug === b.slug && (a.sourceId ?? "") === (b.sourceId ?? "");
}

/**
 * Unique-relation count: upstream reports one ROW per provenance (the same
 * from→to pair arrives separately as markdown AND mcp-remote-mention —
 * probed 0.60.558). Surfaces count RELATIONS (the other side's identity),
 * never raw rows, so the detail captions and the drawers never disagree.
 */
export function relationCount(
  rows: LinkRow[] | undefined,
  direction: "out" | "in",
): number {
  if (!rows) return 0;
  const key = (r: LinkRow) =>
    direction === "out"
      ? `${r.to_source_id ?? ""}/${r.to_slug ?? ""}`
      : `${r.from_source_id ?? ""}/${r.from_slug ?? ""}`;
  return new Set(rows.map(key)).size;
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
 * Fetch a page bundle by (slug, source?) with a sequence guard: rapid
 * re-selection can only ever land the LAST ref — late responses are dropped.
 * `null` is idle (no request). `full` adds the V1.1 provenance sections
 * (links / backlinks / timeline) — the drawers opt in for their light rows;
 * the server's 10s section cache keeps repeat peeks cheap.
 */
export function usePageBundle(ref: PageRef | null, opts?: { full?: boolean }) {
  const [bundle, setBundle] = useState<PageBundle | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const seq = useRef(0);
  const refKey = ref ? `${ref.sourceId ?? ""}/${ref.slug}` : "";
  const full = opts?.full === true;

  useEffect(() => {
    const mine = ++seq.current;
    setBundle(null);
    setError(null);
    setLoading(ref !== null);
    if (!ref) return;
    apiGet<PageBundle>(`/api/page?${pageRefQuery(ref)}${full ? "&full=1" : ""}`)
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refKey, full]);

  return { bundle, error, loading };
}

/**
 * Same-slug pages in OTHER sources (the disambiguation affordance). gbrain
 * resolves a bare slug SILENTLY (source_id ASC LIMIT 1); cockpit asks search
 * for this exact slug and lists every other source it lives in, so a bare
 * open shows WHICH page you got — and offers the jump. Rides the server's
 * 30s search cache; failures degrade to "no siblings known".
 */
export function useSlugSiblings(
  slug: string | null,
  excludeSource?: string,
): SearchHit[] {
  const [siblings, setSiblings] = useState<SearchHit[]>([]);
  const seq = useRef(0);
  const key = `${excludeSource ?? ""}·${slug ?? ""}`;

  useEffect(() => {
    const mine = ++seq.current;
    if (!slug || !isSlugLike(slug)) {
      setSiblings([]);
      return;
    }
    apiGet<SearchHit[]>(`/api/search?q=${encodeURIComponent(slug)}`)
      .then((hits) => {
        if (seq.current !== mine) return;
        setSiblings(
          hits.filter(
            (h) => h.slug === slug && h.source_id !== undefined && h.source_id !== excludeSource,
          ),
        );
      })
      .catch(() => {
        if (seq.current === mine) setSiblings([]);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return siblings;
}
