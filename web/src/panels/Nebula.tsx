import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Graph from "graphology";
import louvain from "graphology-communities-louvain";
import forceAtlas2 from "graphology-layout-forceatlas2";
import Sigma from "sigma";
import type { EdgeProposal, GraphReport } from "@gbrain-cockpit/shared";
import { GRAPH } from "../design/tokens";
import { ApiError, apiGet } from "../lib/api";
import { useI18n, type MessageKey } from "../lib/i18n";

// Nebula — the whole-brain map on the read-only bypass (ARCHITECTURE §3.3/§6).
// Human vocabulary (owner decision 2026-11-04): a node IS a page, an edge IS
// a relation between two pages. Views: 全景 overview (default) / 聚焦 focus
// (a page's ≤2-step neighborhood) / 关系矩阵 relation matrix (neighborhood
// grid) / 原版 stock (the same graph rendered with sigma's factory look, no
// Deep Field skin — an owner comparison affordance). Skin: Deep Field
// (2026-11-04 style review, candidate A) — a dark observation window inset
// in the light Mint desk: borderless luminous nodes with additive glow
// sprites, no community hulls, hover = neighborhood focus (the hovered
// page's 1-hop set stays lit, everything else dims through the nodeReducer).
// FA2 layout coordinates are frozen per graph fingerprint (localStorage) so
// dream diffs stay comparable; labels render on sigma's canvas (native
// canvas text — immune to HTML injection); node colors map page type, node
// size and label size map relation count; relation color maps link_type,
// the amber dash stays reserved for pending (un-adjudicated) dream
// relations; pages with pending proposals pulse. All colors come from the
// same-source GRAPH palette.
//
// Performance contract: sigma mounts ONCE per data change — paradigm and
// selection switches filter through nodeReducer (no graph rebuild, no WebGL
// remount), and the overlay canvas only repaints when the camera, the pulse
// tick, the filters or the selection actually changed (dirty check).

type ViewKind = "field" | "orbit" | "matrix" | "plain";

const VIEW_KEY = "cockpit.nebula.view";
const NOISE_KEY = "cockpit.nebula.noise";
const LAYOUT_PREFIX = "cockpit.nebula.layout.";
const NOISE_DEGREE = 3;
const MATRIX_MAX = 24;

/** deterministic role rotation by page type (Deep Field luminous roles) */
const TYPE_ROLES = GRAPH.typeRoles;

function typeColor(type: string | undefined): string {
  if (!type) return GRAPH.ghost;
  let h = 0;
  for (let i = 0; i < type.length; i++) h = ((h << 5) - h + type.charCodeAt(i)) | 0;
  return TYPE_ROLES[Math.abs(h) % TYPE_ROLES.length]!;
}

/** relation color = link_type (semantic); unknown types stay neutral grey */
function edgeTypeColor(type: string | undefined): string {
  return (type && GRAPH.edgeTypes[type]) || GRAPH.edgeUnknown;
}

/** #rrggbb → rgba(…, alpha); anything else passes through untouched */
function withAlpha(hex: string, alpha: number): string {
  if (hex.length !== 7 || hex[0] !== "#") return hex;
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

function nodeRadius(degree: number, focus: boolean): number {
  return (3 + Math.sqrt(degree) * 2.3) * (focus ? 1.15 : 1);
}

/** distance from a pointer to a segment — overlay-edge proximity hover */
function pointSegmentDistance(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function hops(graph: Graph, start: string, maxHops: number): Map<string, number> {
  const dist = new Map<string, number>([[start, 0]]);
  let frontier = [start];
  for (let d = 1; d <= maxHops; d++) {
    const next: string[] = [];
    for (const n of frontier) {
      for (const nb of graph.neighbors(n)) {
        if (!dist.has(nb)) {
          dist.set(nb, d);
          next.push(nb);
        }
      }
    }
    frontier = next;
  }
  return dist;
}

/** read an edge-proposal endpoint pair defensively (shape varies by version) */
function proposalPair(p: EdgeProposal): [string, string] | null {
  const candidates: [string, string][] = [
    ["from_slug", "to_slug"],
    ["from", "to"],
    ["source", "target"],
  ];
  for (const [a, b] of candidates) {
    const va = p[a];
    const vb = p[b];
    if (typeof va === "string" && typeof vb === "string" && va && vb) return [va, vb];
  }
  return null;
}

function loadLayout(fingerprint: string): Record<string, [number, number]> | null {
  try {
    const raw = localStorage.getItem(LAYOUT_PREFIX + fingerprint);
    const parsed = raw ? (JSON.parse(raw) as { positions?: Record<string, [number, number]> }) : null;
    return parsed?.positions ?? null;
  } catch {
    return null;
  }
}

function saveLayout(fingerprint: string, graph: Graph): void {
  const positions: Record<string, [number, number]> = {};
  graph.forEachNode((node, attrs) => {
    positions[node] = [attrs.x, attrs.y];
  });
  try {
    localStorage.setItem(LAYOUT_PREFIX + fingerprint, JSON.stringify({ positions }));
  } catch {
    // storage full/blocked — layout just won't freeze; refetch recomputes
  }
}

/** FA2 layout — golden-angle spiral seeds, iteration budget scales with size */
function computeLayout(graph: Graph): void {
  if (graph.order === 0) return;
  let i = 0;
  graph.forEachNode((node) => {
    const angle = i * 2.39996;
    const radius = 5 * Math.sqrt(i + 1);
    graph.setNodeAttribute(node, "x", radius * Math.cos(angle));
    graph.setNodeAttribute(node, "y", radius * Math.sin(angle));
    i++;
  });
  forceAtlas2.assign(graph, {
    iterations: graph.order <= 500 ? 60 : graph.order <= 2000 ? 30 : 15,
    settings: {
      barnesHutOptimize: graph.order > 1000,
      gravity: 0.5,
      scalingRatio: 8,
      slowDown: 2,
    },
  });
}

/** Errors shown to the browser stay one line — full text is server-log only. */
function firstLine(error?: string): string {
  if (!error) return "";
  return (error.split("\n").find((l) => l.trim()) ?? "").slice(0, 200);
}

export function Nebula({ onOpenPage }: { onOpenPage?: (slug: string) => void }) {
  const { t } = useI18n();
  const [report, setReport] = useState<GraphReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<ViewKind>(() => {
    const v = localStorage.getItem(VIEW_KEY);
    return v === "orbit" || v === "matrix" || v === "plain" ? v : "field";
  });
  // noise filter defaults ON: a young brain is mostly isolated pages, and the
  // overview reads as meaningless dust until relations accumulate
  const [noise, setNoise] = useState(() => {
    const v = localStorage.getItem(NOISE_KEY);
    return v === null ? true : v === "1";
  });
  /** relation types the owner toggled off in the legend (themed views) */
  const [hiddenTypes, setHiddenTypes] = useState<Set<string>>(() => new Set());
  const [selected, setSelected] = useState<string | null>(null);
  const [locate, setLocate] = useState("");

  const wrapRef = useRef<HTMLDivElement>(null);
  const mountRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const sigmaRef = useRef<Sigma | null>(null);
  const mouseRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  // hovered page (overlay draws the mockup's 2.5px ink ring at r+3.5 for it)
  const hoveredRef = useRef<string | null>(null);
  // bump to force one overlay repaint (pulse tick / hover / selection / filter)
  const overlayDirty = useRef(0);
  // live closure refs for sigma's nodeReducer and the overlay loop
  const tRef = useRef(t);
  tRef.current = t;
  const fieldCameraRef = useRef<{ x: number; y: number; ratio: number; angle: number } | null>(null);
  const prevViewRef = useRef(view);

  const refresh = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      setReport(await apiGet<GraphReport>("/api/graph"));
    } catch (err) {
      setReport(null);
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // dream-new relations share the Inbox queue's data (same data, two surfaces)
  const [proposalEdges, setProposalEdges] = useState<[string, string][]>([]);
  useEffect(() => {
    apiGet<{ edgeProposals?: { items?: EdgeProposal[] } }>("/api/inbox")
      .then((inbox) => {
        setProposalEdges(
          (inbox.edgeProposals?.items ?? [])
            .map(proposalPair)
            .filter((p): p is [string, string] => p !== null),
        );
      })
      .catch(() => setProposalEdges([]));
  }, []);

  // --- base data: full graph, frozen layout, communities ----------------------

  const baseData = useMemo(() => {
    const nodes = report?.nodes ?? [];
    const edges = report?.edges ?? [];
    const fingerprint = report?.fingerprint;
    if (nodes.length === 0 || !fingerprint) return null;

    const slugSet = new Set(nodes.map((n) => n.slug));
    const newEdgeSet = new Set(
      proposalEdges
        .filter(([a, b]) => slugSet.has(a) && slugSet.has(b))
        .map(([a, b]) => (a < b ? `${a}||${b}` : `${b}||${a}`)),
    );
    const pending = new Set<string>();
    for (const [a, b] of proposalEdges) {
      if (slugSet.has(a)) pending.add(a);
      if (slugSet.has(b)) pending.add(b);
    }

    // structural graph for layout + community detection (view-independent)
    const full = new Graph({ multi: false, type: "undirected" });
    for (const n of nodes) full.addNode(n.slug, {});
    const seen = new Set<string>();
    for (const e of edges) {
      if (!slugSet.has(e.source) || !slugSet.has(e.target)) continue;
      const key = e.source < e.target ? `${e.source}||${e.target}` : `${e.target}||${e.source}`;
      if (seen.has(key)) continue;
      seen.add(key);
      full.addEdge(e.source, e.target, {});
    }

    // frozen layout per fingerprint (dream diffs stay comparable)
    const stored = loadLayout(fingerprint);
    if (stored && Object.keys(stored).length === full.order) {
      full.forEachNode((node) => {
        const p = stored[node];
        if (p) {
          full.setNodeAttribute(node, "x", p[0]);
          full.setNodeAttribute(node, "y", p[1]);
        }
      });
    } else {
      computeLayout(full);
      saveLayout(fingerprint, full);
    }

    // communities (matrix ordering only — the Deep Field skin draws no hulls)
    try {
      louvain.assign(full);
    } catch {
      // leave unassigned; matrix ordering just falls back to degree sort
    }

    const degree = new Map<string, number>();
    full.forEachNode((node) => degree.set(node, full.degree(node)));
    return { nodes, edges, fingerprint, full, degree, pending, newEdgeSet };
  }, [report, proposalEdges]);

  // --- view filtering (nodeReducer — no graph rebuild, no sigma remount) -------

  /** focus view membership: the selected page's ≤2-step neighborhood */
  const members = useMemo(() => {
    if (!baseData || view !== "orbit" || !selected) return null;
    if (!baseData.full.hasNode(selected)) return null;
    return new Set(hops(baseData.full, selected, 2).keys());
  }, [baseData, view, selected]);

  const filterRef = useRef<{
    view: ViewKind;
    noise: boolean;
    members: Set<string> | null;
    pending: Set<string>;
    /** hovered page + its 1-hop neighbors (null when not hovering) */
    hoverNear: Set<string> | null;
  }>({ view, noise, members, pending: new Set(), hoverNear: null });
  filterRef.current = {
    view,
    noise,
    members,
    pending: baseData?.pending ?? new Set(),
    // hoverNear is event-driven state — carry it across the reassignment
    hoverNear: filterRef.current.hoverNear,
  };

  /** the single visibility predicate — sigma's nodeReducer AND the overlay
   *  both call it, so DOM and canvas can never disagree */
  const isHidden = useCallback((node: string, degree: number): boolean => {
    const f = filterRef.current;
    if (f.view === "orbit") return f.members !== null && !f.members.has(node);
    if (f.view === "matrix") return false;
    return f.noise && degree < NOISE_DEGREE && !f.pending.has(node);
  }, []);

  // --- the one graphology instance sigma mounts (data-only deps) ----------------

  const viewGraph = useMemo(() => {
    if (!baseData) return null;
    const { nodes, full, degree, pending, newEdgeSet, edges, fingerprint } = baseData;

    const graph = new Graph({ multi: false, type: "undirected" });
    for (const n of nodes) {
      const slug = n.slug;
      const deg = degree.get(slug) ?? n.degree ?? 0;
      const pos = full.getNodeAttributes(slug);
      graph.addNode(slug, {
        label: slug,
        type: n.type,
        title: n.title,
        updated_at: n.updated_at,
        degree: deg,
        community: full.getNodeAttribute(slug, "community"),
        color: typeColor(n.type),
        size: nodeRadius(deg, view === "orbit"),
        x: pos.x,
        y: pos.y,
        forceLabel: pending.has(slug) || deg >= 8,
        // sigma 4 label styling (per-node): body font, hubs bigger + heavier
        // (Deep Field reads top-N pages first)
        labelFont: GRAPH.labelFont,
        labelSize: Math.min(Math.max(10 + deg * 0.42, 11), 15),
        labelWeight: deg >= 8 ? "600" : "400",
        labelColor: GRAPH.labelColor,
      });
    }
    // ALL relations enter the sigma graph (the 原版 stock view renders them
    // with sigma's own edge program; themed views hide them via edgeReducer
    // and the overlay draws them typed/dashed instead — sigma cannot dash).
    // allEdges mirrors them for the overlay + proximity hover.
    const allEdges: { source: string; target: string; link_type?: string; isNew: boolean }[] = [];
    for (const e of edges) {
      if (!graph.hasNode(e.source) || !graph.hasNode(e.target)) continue;
      if (graph.hasEdge(e.source, e.target)) continue;
      const key = e.source < e.target ? `${e.source}||${e.target}` : `${e.target}||${e.source}`;
      const isNew = newEdgeSet.has(key);
      graph.addEdge(e.source, e.target, {
        link_type: e.link_type,
        isNew,
        color: GRAPH.edgeUnknown,
        size: GRAPH.edgeWidth,
      });
      allEdges.push({ source: e.source, target: e.target, link_type: e.link_type, isNew });
    }
    return { graph, pending, allEdges, fingerprint };
    // view intentionally NOT a dep: node size bumps for focus view are
    // applied by the selection effect below; filtering is reducer-side
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseData]);

  // --- sigma lifecycle: mount once per data, unmount only for the matrix -------
  // sigma needs a laid-out container (it reads offsetWidth at construction and
  // throws on 0). Embedded webviews can lay out at ZERO width for a few frames
  // right after navigation, so when that happens the mount arms a
  // ResizeObserver on the container and retries (observe reports the current
  // size immediately, so the normal case still mounts on the first pass).

  const isMatrix = view === "matrix";
  const [mountTick, setMountTick] = useState(0);

  useEffect(() => {
    if (!viewGraph || isMatrix) return;
    const el = mountRef.current;
    if (!el) return;
    if (el.offsetWidth === 0) {
      const ro = new ResizeObserver(() => {
        if (el.offsetWidth > 0) {
          ro.disconnect();
          setMountTick((x) => x + 1);
        }
      });
      ro.observe(el);
      return () => ro.disconnect();
    }
    const { graph, pending } = viewGraph;

    const sigma = new Sigma(graph, mountRef.current, {
      nodeReducer: (node, data) => {
        const shown = isHidden(node, graph.getNodeAttribute(node, "degree") ?? 0)
          ? { ...data, hidden: true }
          : data;
        // 原版 stock view: strip the Deep Field skin (factory colors, default
        // label font) while keeping data-driven size/position — no focus dim
        if (filterRef.current.view === "plain") {
          return { ...shown, color: GRAPH.stock.node, labelColor: GRAPH.stock.label, labelFont: "sans-serif" };
        }
        // hover = neighborhood focus: pages outside the hovered page's 1-hop
        // set fade (fill AND label) until the pointer leaves
        const near = filterRef.current.hoverNear;
        if (near && !near.has(node)) {
          return {
            ...shown,
            color: withAlpha(typeof shown.color === "string" ? shown.color : GRAPH.ghost, GRAPH.dim),
            labelColor: withAlpha(GRAPH.labelColor, GRAPH.dim),
          };
        }
        return shown;
      },
      // themed views draw relations on the overlay canvas (typed colors +
      // amber dashes, which sigma's edge program cannot do); only the 原版
      // view lets sigma's own edge program render them, in factory grey
      edgeReducer: (_edge, data) =>
        filterRef.current.view === "plain"
          ? { ...data, color: GRAPH.stock.edge }
          : { ...data, hidden: true },
      settings: {
        labelDensity: 0.6,
        labelGridCellSize: 100,
        // Deep Field: hubs label first — small pages stay anonymous until zoom
        labelRenderedSizeThreshold: 9,
        minCameraRatio: 0.02,
        maxCameraRatio: 12,
      },
    });
    sigmaRef.current = sigma;
    overlayDirty.current++; // the overlay's first frame needs sigma in place

    // click SELECTS (drawer opens in place); the focus view is entered
    // explicitly via the tab or the drawer button — no surprise teleports
    sigma.on("clickNode", ({ node }) => setSelected(node));
    sigma.on("clickStage", () => setSelected(null));
    sigma.on("enterNode", ({ node }) => {
      hoveredRef.current = node;
      // neighborhood focus: the hovered page's 1-hop set stays lit, the rest
      // dims (applied reducer-side on this refresh, overlay-side for edges)
      const near = new Set<string>([node]);
      graph.forEachNeighbor(node, (nb) => near.add(nb));
      filterRef.current.hoverNear = near;
      sigma.refresh();
      overlayDirty.current++;
      const attrs = graph.getNodeAttributes(node);
      showTip(
        pending.has(node)
          ? `${node} · ${attrs.degree} · ${tRef.current("nebula.tipPending")}`
          : `${node} · ${attrs.degree}`,
      );
    });
    sigma.on("leaveNode", () => {
      hoveredRef.current = null;
      filterRef.current.hoverNear = null;
      sigma.refresh();
      overlayDirty.current++;
      hideTip();
    });
    sigma.on("enterEdge", ({ edge }) => {
      const attrs = graph.getEdgeAttributes(edge);
      const [a, b] = graph.extremities(edge);
      showTip(`${attrs.link_type ?? "?"} · ${a} → ${b}`);
    });
    sigma.on("leaveEdge", hideTip);

    return () => {
      sigma.kill();
      sigmaRef.current = null;
      hideTip();
    };
    // mountTick: retried after a zero-width webview frame grew a real size
  }, [viewGraph, isMatrix, mountTick, isHidden]);

  // view transitions: entering focus saves the overview camera and centers on
  // the selected page; returning to overview restores it
  useEffect(() => {
    const sigma = sigmaRef.current;
    if (!sigma) return;
    const camera = sigma.getCamera();
    const reduced = document.documentElement.classList.contains("rm");
    if (view === "orbit" && prevViewRef.current !== "orbit") {
      fieldCameraRef.current = camera.getState();
    }
    if (
      view === "orbit" &&
      prevViewRef.current === "orbit" &&
      fieldCameraRef.current === null
    ) {
      fieldCameraRef.current = camera.getState();
    }
    if (view === "orbit" && selected && viewGraph?.graph.hasNode(selected)) {
      const attrs = viewGraph.graph.getNodeAttributes(selected);
      // camera x/y are framed-graph (~[0,1]) space, not raw layout coords
      // (see the auto-fit effect) — convert or the focus view centers on
      // empty space
      const center = sigma.graphToFramedGraph({ x: attrs.x, y: attrs.y });
      if (Number.isFinite(center.x) && Number.isFinite(center.y)) {
        if (reduced) camera.setState({ x: center.x, y: center.y, ratio: 0.4 });
        else camera.animate({ x: center.x, y: center.y, ratio: 0.4 }, { duration: 500 });
      }
    } else if (view === "field" && prevViewRef.current === "orbit" && fieldCameraRef.current) {
      const saved = fieldCameraRef.current;
      if (reduced) camera.setState(saved);
      else camera.animate(saved, { duration: 400 });
    }
    prevViewRef.current = view;
    overlayDirty.current++;
  }, [view, selected, viewGraph]);

  // overview/stock auto-fit: sigma's default camera frames the RAW bbox —
  // hidden noise pages and layout outliers leave dead space around the
  // visible cluster. Frame the VISIBLE pages instead. The camera matrices
  // are not built until sigma's first refresh: measuring viewportToGraph
  // before that returns garbage which would slam the ratio to its clamp and
  // shrink the whole graph to subpixels (a broken-looking blank window), so
  // the fit first self-checks readiness (graphToViewport of two distant
  // points must be finite and non-degenerate) and retries next frame. The
  // scale factor is also invariant-clamped: the visible bbox is a subset of
  // the raw one the default camera frames, so a valid fit never needs to
  // zoom out more than the padding factor — anything larger is a bad
  // measurement and is rejected. Skipped right after a view switch so the
  // orbit→overview camera restore wins; the orbit view centers itself.
  useEffect(() => {
    const sigma = sigmaRef.current;
    const wrap = wrapRef.current;
    if (!sigma || !wrap || !viewGraph || (view !== "field" && view !== "plain")) return;
    if (prevViewRef.current !== view) return; // a transition effect owns this render
    if (wrap.clientWidth === 0 || wrap.clientHeight === 0) return;
    let raf = 0;
    let tries = 0;
    const attempt = () => {
      if (sigmaRef.current !== sigma) return; // unmounted before the frame
      const a = sigma.graphToViewport({ x: 0, y: 0 });
      const b = sigma.graphToViewport({ x: 100, y: 100 });
      const ready =
        [a.x, a.y, b.x, b.y].every(Number.isFinite) &&
        (Math.abs(a.x - b.x) > 1 || Math.abs(a.y - b.y) > 1);
      if (!ready) {
        if (++tries < 30) raf = requestAnimationFrame(attempt);
        return; // keep the default framing — better than a wrong one
      }
      const { graph } = viewGraph;
      let x0 = Infinity;
      let y0 = Infinity;
      let x1 = -Infinity;
      let y1 = -Infinity;
      let any = false;
      graph.forEachNode((node, attrs) => {
        if (isHidden(node, attrs.degree ?? 0)) return;
        any = true;
        x0 = Math.min(x0, attrs.x);
        x1 = Math.max(x1, attrs.x);
        y0 = Math.min(y0, attrs.y);
        y1 = Math.max(y1, attrs.y);
      });
      if (!any || !(x1 > x0) || !(y1 > y0)) return;
      const tl = sigma.viewportToGraph({ x: 0, y: 0 });
      const br = sigma.viewportToGraph({ x: wrap.clientWidth, y: wrap.clientHeight });
      const spanX = Math.abs(br.x - tl.x);
      const spanY = Math.abs(br.y - tl.y);
      if (!Number.isFinite(spanX) || !Number.isFinite(spanY) || spanX <= 0 || spanY <= 0) return;
      const PAD = 1.18;
      const f = Math.max(((x1 - x0) * PAD) / spanX, ((y1 - y0) * PAD) / spanY);
      if (!Number.isFinite(f) || f > PAD || f < 0.06) return; // bad measurement
      // CAMERA-SPACE TRAP: camera x/y live in the normalized ~[0,1] framed
      // graph space, NOT raw layout coords — setting raw coords points the
      // frustum outside the graph and the whole window renders empty. Always
      // convert through graphToFramedGraph.
      const center = sigma.graphToFramedGraph({ x: (x0 + x1) / 2, y: (y0 + y1) / 2 });
      if (!Number.isFinite(center.x) || !Number.isFinite(center.y)) return;
      const cam = sigma.getCamera();
      cam.setState({ x: center.x, y: center.y, ratio: cam.getState().ratio * f });
      overlayDirty.current++;
    };
    raf = requestAnimationFrame(attempt);
    return () => cancelAnimationFrame(raf);
  }, [viewGraph, view, noise, isHidden, mountTick]);

  // selection emphasis + filter changes: attribute bumps + one refresh (the
  // reducer re-evaluates visibility on every refresh — no remount)
  useEffect(() => {
    const sigma = sigmaRef.current;
    if (!sigma || !viewGraph) return;
    const graph = viewGraph.graph;
    graph.forEachNode((node, attrs) => {
      const base = nodeRadius(attrs.degree, view === "orbit");
      graph.setNodeAttribute(node, "size", node === selected ? base + 3 : base);
      graph.setNodeAttribute(
        node,
        "forceLabel",
        node === selected || viewGraph.pending.has(node),
      );
    });
    sigma.refresh();
    overlayDirty.current++;
  }, [selected, viewGraph, view, noise, members]);

  // pending-page pulse: slow size oscillation (reduced-motion shows steady)
  useEffect(() => {
    if (!viewGraph || viewGraph.pending.size === 0 || view === "matrix") return;
    if (document.documentElement.classList.contains("rm")) return;
    let up = false;
    const timer = setInterval(() => {
      const sigma = sigmaRef.current;
      if (!sigma) return;
      const graph = viewGraph.graph;
      up = !up;
      for (const node of viewGraph.pending) {
        if (!graph.hasNode(node)) continue;
        const attrs = graph.getNodeAttributes(node);
        const base = nodeRadius(attrs.degree, view === "orbit") + (node === selected ? 3 : 0);
        graph.setNodeAttribute(node, "size", up ? base + 1.5 : base);
      }
      sigma.refresh();
      overlayDirty.current++;
    }, 700);
    return () => clearInterval(timer);
  }, [viewGraph, view, selected]);

  // --- overlay canvas: node glow + typed relations + rings + vignette ----------
  // sigma 4 has no glow, dashed-edge or vignette primitives, so the overlay
  // draws them camera-synced through sigma.graphToViewport/scaleSize. The rAF
  // loop stays cheap when idle: it skips the whole draw unless the camera
  // state, the dirty counter, or the canvas size changed since last frame.

  useEffect(() => {
    if (!viewGraph || view === "matrix" || view === "plain") return;
    const { graph, allEdges, pending } = viewGraph;

    // glow sprites: one radial-gradient disc per distinct node color (only a
    // handful exist), drawn additively so stacked halos read as density
    const glowCache = new Map<string, HTMLCanvasElement>();
    function glowSprite(color: string): HTMLCanvasElement {
      let sprite = glowCache.get(color);
      if (!sprite) {
        sprite = document.createElement("canvas");
        sprite.width = sprite.height = 96;
        const g = sprite.getContext("2d");
        if (g) {
          const grad = g.createRadialGradient(48, 48, 0, 48, 48, 48);
          grad.addColorStop(0, withAlpha(color, 0.5));
          grad.addColorStop(0.45, withAlpha(color, 0.22));
          grad.addColorStop(1, withAlpha(color, 0));
          g.fillStyle = grad;
          g.fillRect(0, 0, 96, 96);
        }
        glowCache.set(color, sprite);
      }
      return sprite;
    }

    // NOTE: glow reads node attributes LIVE each frame (not a setup-time
    // snapshot) because the pulse and selection effects mutate `size`.

    let raf = 0;
    let running = true;
    let lastCamKey = "";
    let lastDirty = -1;
    let lastW = 0;
    let lastH = 0;
    let lastPaint = 0;
    let vignette: { w: number; h: number; grad: CanvasGradient } | null = null;
    const onVisibility = () => {
      running = !document.hidden;
      if (running) {
        overlayDirty.current++; // frames were throttled away — force one
        loop();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    // rAF backstop: embedded webviews can leave rAF stalled while the page
    // stays visible (the overlay would freeze on one frame forever). If no
    // paint happened for 450ms, force one from the interval — with a healthy
    // rAF this never fires.
    const backstop = window.setInterval(() => {
      if (running && performance.now() - lastPaint > 450) loop();
    }, 500);

    function loop() {
      if (!running) return;
      raf = requestAnimationFrame(loop);
      const sigma = sigmaRef.current;
      const overlay = overlayRef.current;
      const wrap = wrapRef.current;
      if (!sigma || !overlay || !wrap) return;
      const dpr = window.devicePixelRatio || 1;
      const w = wrap.clientWidth;
      const h = wrap.clientHeight;
      // camera readiness gate: sigma's matrices lag its first refresh —
      // painting before they exist draws NaN geometry (a frozen blank-ish
      // frame). Skip such frames entirely; the next one catches up.
      const ra = sigma.graphToViewport({ x: 0, y: 0 });
      const rb = sigma.graphToViewport({ x: 100, y: 100 });
      if (
        ![ra.x, ra.y, rb.x, rb.y].every(Number.isFinite) ||
        (Math.abs(ra.x - rb.x) <= 1 && Math.abs(ra.y - rb.y) <= 1)
      ) {
        return;
      }
      const cam = sigma.getCamera().getState();
      const camKey = `${cam.x}|${cam.y}|${cam.ratio}|${cam.angle}`;
      // idle frames skip the whole draw; the 1s backstop guarantees recovery
      // from throttled/occluded tabs whose rAF stops mid-check (their first
      // frame back would otherwise look "unchanged" and skip forever)
      if (
        camKey === lastCamKey &&
        overlayDirty.current === lastDirty &&
        w === lastW &&
        h === lastH &&
        performance.now() - lastPaint < 1000
      ) {
        return; // idle frame — nothing moved, nothing pulsed, no repaint
      }
      lastCamKey = camKey;
      lastDirty = overlayDirty.current;
      lastW = w;
      lastH = h;
      lastPaint = performance.now();
      if (overlay.width !== Math.round(w * dpr) || overlay.height !== Math.round(h * dpr)) {
        overlay.width = Math.round(w * dpr);
        overlay.height = Math.round(h * dpr);
      }
      const ctx = overlay.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      const hoverNear = filterRef.current.hoverNear;

      // node glow — additive so stacked halos accumulate like starlight;
      // focused-out pages keep a faint mark instead of their glow
      ctx.globalCompositeOperation = "lighter";
      graph.forEachNode((node, attrs) => {
        if (isHidden(node, attrs.degree)) return;
        ctx.globalAlpha = hoverNear !== null && !hoverNear.has(node) ? GRAPH.dim : 1;
        const pos = sigma.graphToViewport({ x: attrs.x, y: attrs.y });
        const r = sigma.scaleSize(attrs.size) * GRAPH.glowRadius;
        ctx.drawImage(glowSprite(String(attrs.color)), pos.x - r, pos.y - r, r * 2, r * 2);
      });
      ctx.globalCompositeOperation = "source-over";
      ctx.globalAlpha = 1;

      // relations — semantic: color = link_type, the amber dash is reserved
      // for the pending (un-adjudicated) STATE. Drawn on the overlay because
      // sigma's edge program can neither dash nor cheaply per-type color.
      // Pending relations draw last so they sit on top; an edge focuses out
      // together with either endpoint outside the hovered 1-hop set.
      const solid: typeof allEdges = [];
      const pendingEdges: typeof allEdges = [];
      for (const e of allEdges) {
        if (hiddenTypes.has(e.link_type ?? "?")) continue;
        if (!graph.hasNode(e.source) || !graph.hasNode(e.target)) continue;
        const a = graph.getNodeAttributes(e.source);
        const b = graph.getNodeAttributes(e.target);
        if (isHidden(e.source, a.degree) || isHidden(e.target, b.degree)) continue;
        (e.isNew ? pendingEdges : solid).push(e);
      }
      const drawEdge = (
        e: (typeof allEdges)[number],
        color: string,
        width: number,
        dash: number[],
        alpha: number,
      ) => {
        const a = graph.getNodeAttributes(e.source);
        const b = graph.getNodeAttributes(e.target);
        const va = sigma.graphToViewport({ x: a.x, y: a.y });
        const vb = sigma.graphToViewport({ x: b.x, y: b.y });
        ctx.globalAlpha = alpha;
        ctx.strokeStyle = color;
        ctx.lineWidth = width;
        ctx.setLineDash(dash);
        ctx.beginPath();
        ctx.moveTo(va.x, va.y);
        ctx.lineTo(vb.x, vb.y);
        ctx.stroke();
      };
      const nearEdge = (e: (typeof allEdges)[number]): boolean =>
        hoverNear === null || (hoverNear.has(e.source) && hoverNear.has(e.target));
      for (const e of solid) {
        drawEdge(
          e,
          edgeTypeColor(e.link_type),
          GRAPH.edgeWidth,
          [],
          nearEdge(e) ? GRAPH.edgeAlpha : GRAPH.edgeAlpha * GRAPH.dim,
        );
      }
      for (const e of pendingEdges) {
        drawEdge(e, GRAPH.edgeNew, GRAPH.edgeNewWidth, [6, 3], nearEdge(e) ? 1 : GRAPH.dim);
      }
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;

      // pending pages: steady amber ring (the size pulse stays the motion)
      ctx.strokeStyle = GRAPH.pendingRing;
      ctx.lineWidth = 1.8;
      ctx.globalAlpha = 0.75;
      for (const node of pending) {
        if (!graph.hasNode(node)) continue;
        const attrs = graph.getNodeAttributes(node);
        if (isHidden(node, attrs.degree)) continue;
        const pos = sigma.graphToViewport({ x: attrs.x, y: attrs.y });
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, sigma.scaleSize(attrs.size) + 4, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;

      // hover/selected emphasis ring: white, lw 2.5, at radius + 3.5
      const focus = hoveredRef.current ?? selected;
      if (focus && graph.hasNode(focus)) {
        const attrs = graph.getNodeAttributes(focus);
        if (!isHidden(focus, attrs.degree)) {
          const pos = sigma.graphToViewport({ x: attrs.x, y: attrs.y });
          ctx.strokeStyle = GRAPH.hoverRing;
          ctx.lineWidth = 2.5;
          ctx.beginPath();
          ctx.arc(pos.x, pos.y, sigma.scaleSize(attrs.size) + 3.5, 0, Math.PI * 2);
          ctx.stroke();
        }
      }

      // focus rings (1/2 steps) around the selected page
      if (view === "orbit" && selected && graph.hasNode(selected)) {
        const attrs = graph.getNodeAttributes(selected);
        const center = sigma.graphToViewport({ x: attrs.x, y: attrs.y });
        ctx.setLineDash([6, 5]);
        for (const frac of [0.18, 0.34]) {
          const r = frac * Math.min(w, h);
          ctx.strokeStyle = GRAPH.orbitRing;
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.arc(center.x, center.y, r, 0, Math.PI * 2);
          ctx.stroke();
          ctx.font = `400 10px ${GRAPH.labelFont}`;
          ctx.fillStyle = GRAPH.orbitRing;
          ctx.fillText(
            frac < 0.3 ? tRef.current("nebula.hop1") : tRef.current("nebula.hop2"),
            center.x + r * 0.7,
            center.y - r * 0.7,
          );
        }
        ctx.setLineDash([]);
      }

      // corner vignette — the window's glass, cached per size
      if (!vignette || vignette.w !== w || vignette.h !== h) {
        const grad = ctx.createRadialGradient(
          w / 2,
          h / 2,
          Math.min(w, h) * 0.38,
          w / 2,
          h / 2,
          Math.max(w, h) * 0.75,
        );
        grad.addColorStop(0, GRAPH.vignetteClear);
        grad.addColorStop(1, GRAPH.vignette);
        vignette = { w, h, grad };
      }
      ctx.fillStyle = vignette.grad;
      ctx.fillRect(0, 0, w, h);
    }
    loop();
    return () => {
      running = false;
      cancelAnimationFrame(raf);
      window.clearInterval(backstop);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [viewGraph, view, selected, noise, hiddenTypes, isHidden]);

  // --- tooltip helpers -------------------------------------------------------------

  function showTip(text: string) {
    const tip = tipRef.current;
    const wrap = wrapRef.current;
    if (!tip || !wrap) return;
    tip.textContent = text; // untrusted content: textContent, never innerHTML
    tip.classList.add("show");
    const rect = wrap.getBoundingClientRect();
    tip.style.left = `${Math.min(mouseRef.current.x + 14, rect.width - 200)}px`;
    tip.style.top = `${mouseRef.current.y + 14}px`;
  }

  function hideTip() {
    tipRef.current?.classList.remove("show");
  }

  // --- overlay-edge proximity hover ------------------------------------------------
  // sigma's enterEdge can't see overlay-drawn relations, so themed views
  // hit-test by pointer distance (point→segment, ≤5px). Node hover wins.

  const hoveredEdgeRef = useRef<string | null>(null);

  function hoverEdgeAtPointer(): void {
    const sigma = sigmaRef.current;
    if (!sigma || !viewGraph) return;
    if (hoveredRef.current) return; // a node is under the pointer — it wins
    const m = mouseRef.current;
    let best: { key: string; text: string; dist: number } | null = null;
    for (const e of viewGraph.allEdges.slice(0, 3000)) {
      if (hiddenTypes.has(e.link_type ?? "?")) continue;
      const { graph } = viewGraph;
      if (!graph.hasNode(e.source) || !graph.hasNode(e.target)) continue;
      const a = graph.getNodeAttributes(e.source);
      const b = graph.getNodeAttributes(e.target);
      if (isHidden(e.source, a.degree) || isHidden(e.target, b.degree)) continue;
      const va = sigma.graphToViewport({ x: a.x, y: a.y });
      const vb = sigma.graphToViewport({ x: b.x, y: b.y });
      const dist = pointSegmentDistance(m.x, m.y, va.x, va.y, vb.x, vb.y);
      if (dist <= 5 && (!best || dist < best.dist)) {
        best = {
          key: `${e.source}||${e.target}`,
          dist,
          text:
            `${e.link_type ?? "?"} · ${e.source} → ${e.target}` +
            (e.isNew ? ` · ${t("nebula.tipPending")}` : ""),
        };
      }
    }
    const key = best?.key ?? null;
    if (key !== hoveredEdgeRef.current) {
      hoveredEdgeRef.current = key;
      overlayDirty.current++;
    }
    if (best) showTip(best.text);
    else if (!hoveredRef.current) hideTip();
  }

  // --- locate (search → select + focus) ---------------------------------------------

  function runLocate() {
    const q = locate.trim().toLowerCase();
    if (!q || !baseData) return;
    const hit = baseData.full.nodes().find((n) => n.toLowerCase().includes(q));
    if (!hit) return;
    setSelected(hit);
    // search is an explicit "find this page" action — going straight to the
    // focus view is expected here (unlike clicking a node)
    setView("orbit");
    localStorage.setItem(VIEW_KEY, "orbit");
  }

  function switchView(next: ViewKind) {
    setView(next);
    localStorage.setItem(VIEW_KEY, next);
  }

  function toggleNoise() {
    setNoise((n) => {
      localStorage.setItem(NOISE_KEY, n ? "0" : "1");
      return !n;
    });
  }

  // --- matrix data --------------------------------------------------------------------

  const matrix = useMemo(() => {
    if (!baseData || view !== "matrix") return null;
    const { full, newEdgeSet, pending, degree } = baseData;
    // matrix without a selection falls back to the most-connected page
    const center =
      selected && full.hasNode(selected)
        ? selected
        : ([...full.nodes()].sort((a, b) => degree.get(b)! - degree.get(a)!)[0] ?? null);
    if (!center) return null;
    const dist = hops(full, center, 2);
    const members = [...dist.keys()]
      .sort((a, b) => {
        const ca = Number(full.getNodeAttribute(a, "community") ?? -1);
        const cb = Number(full.getNodeAttribute(b, "community") ?? -1);
        if (ca !== cb) return ca - cb;
        return full.degree(b) - full.degree(a);
      })
      .slice(0, MATRIX_MAX);
    const edgeSet = new Set<string>();
    full.forEachEdge((_e, _attrs, source, target) => {
      edgeSet.add(`${source}→${target}`);
      edgeSet.add(`${target}→${source}`);
    });
    return { members, center, edgeSet, newSet: newEdgeSet, pending };
  }, [baseData, view, selected]);

  // --- render ---------------------------------------------------------------------------

  const selectedAttrs =
    viewGraph && selected && viewGraph.graph.hasNode(selected)
      ? viewGraph.graph.getNodeAttributes(selected)
      : null;

  const typeLegend = useMemo(() => {
    const seen = new Map<string, number>();
    for (const n of report?.nodes ?? []) {
      const key = n.type ?? "?";
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }
    return [...seen.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
  }, [report]);

  const relationLegend = useMemo(() => {
    const seen = new Map<string, number>();
    for (const e of report?.edges ?? []) {
      const key = e.link_type ?? "?";
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }
    return [...seen.entries()].sort((a, b) => b[1] - a[1]);
  }, [report]);

  return (
    <section className="panel nebula">
      <div className="nebula-head">
        <div>
          <h2>{t("panel.nebula.title")}</h2>
          <p className="self">{t("panel.nebula.desc")}</p>
        </div>
        <div className="nebula-tools">
          <div className="vtabs" role="group" aria-label={t("nebula.view.label")}>
            {(["field", "orbit", "matrix", "plain"] as const).map((v) => (
              <button
                key={v}
                type="button"
                className={view === v ? "on" : ""}
                aria-pressed={view === v}
                onClick={() => switchView(v)}
              >
                {t(`nebula.view.${v}` as MessageKey)}
              </button>
            ))}
          </div>
          <button
            type="button"
            className={`noise-btn ${noise ? "on" : ""}`}
            aria-pressed={noise}
            onClick={toggleNoise}
            title={t("nebula.noiseHint")}
          >
            {t("nebula.noise")}
          </button>
          <input
            type="search"
            value={locate}
            onChange={(e) => setLocate(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") runLocate();
            }}
            placeholder={t("nebula.search")}
            maxLength={120}
            aria-label={t("nebula.search")}
          />
          <button type="button" onClick={() => void refresh()} disabled={busy}>
            {busy ? t("common.loading") : t("health.refresh")}
          </button>
        </div>
      </div>

      {error && <p className="error">{error}</p>}
      {report?.status === "down" && (
        <div className="card nebula-note">
          <h3>{t("nebula.down")}</h3>
          <p className="mono small">{firstLine(report.error)}</p>
        </div>
      )}
      {report?.stale && (
        <div className="escalation">
          <div className="inner">
            <b>{t("nebula.stale")}</b>
            <span>{t("nebula.staleDesc")}</span>
          </div>
        </div>
      )}
      {!report && !error && <p className="muted">{t("common.loading")}</p>}
      {report && (report.nodes ?? []).length === 0 && report.status !== "down" && (
        <p className="muted">{t("nebula.empty")}</p>
      )}

      {viewGraph && view !== "matrix" && (
        <div
          className={`graph-wrap ${view === "plain" ? "graph-plain" : ""}`}
          ref={wrapRef}
          onMouseMove={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            mouseRef.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
            // overlay-drawn relations need manual proximity hover (sigma
            // cannot see them); the 原版 view uses sigma's own edge events
            if (view === "field" || view === "orbit") hoverEdgeAtPointer();
          }}
          onMouseLeave={hideTip}
        >
          <div ref={mountRef} className="graph-mount" />
          <canvas ref={overlayRef} className="graph-overlay" />
          <div ref={tipRef} className="graph-tip" />
          {selectedAttrs && selected ? (
            <div className="drawer show">
              <button
                type="button"
                className="close"
                aria-label={t("common.close")}
                onClick={() => setSelected(null)}
              >
                ✕
              </button>
              <p className="cap">{t("nebula.drawer.caption")}</p>
              <h5>{String(selectedAttrs.title ?? selected)}</h5>
              {String(selectedAttrs.title ?? "") !== selected && (
                <div className="kv">
                  <span>slug</span>
                  <span className="mono">{selected}</span>
                </div>
              )}
              <div className="kv">
                <span>{t("nebula.drawer.type")}</span>
                <span className="mono">{String(selectedAttrs.type ?? "?")}</span>
              </div>
              <div className="kv">
                <span>{t("nebula.drawer.degree")}</span>
                <span className="mono">{String(selectedAttrs.degree ?? 0)}</span>
              </div>
              {typeof selectedAttrs.updated_at === "string" && selectedAttrs.updated_at && (
                <div className="kv">
                  <span>{t("pages.updated")}</span>
                  <span className="mono">{selectedAttrs.updated_at.slice(0, 10)}</span>
                </div>
              )}
              {viewGraph.pending.has(selected) && (
                <p className="drawer-pending">
                  <span className="tag warn">{t("nebula.drawer.pending")}</span>
                </p>
              )}
              {Number(selectedAttrs.degree ?? 0) === 0 && (
                <p className="muted small drawer-note">{t("nebula.drawer.noRelations")}</p>
              )}
              <div className="drawer-actions">
                {view !== "orbit" && (
                  <button type="button" onClick={() => switchView("orbit")}>
                    {t("nebula.drawer.focus")}
                  </button>
                )}
                {onOpenPage && (
                  <button
                    type="button"
                    className="linkish"
                    onClick={() => onOpenPage(selected)}
                  >
                    {t("nebula.drawer.openPage")}
                  </button>
                )}
              </div>
            </div>
          ) : null}
        </div>
      )}

      {matrix && (
        <div className="graph-wrap matrix-wrap">
          <p className="graph-caption">
            {t("nebula.matrix.caption")} · {matrix.center}
            {!selected && ` (${t("nebula.matrix.fallback")})`}
          </p>
          <div
            className="matrix-grid"
            style={{ gridTemplateColumns: `auto repeat(${matrix.members.length}, 24px)` }}
          >
            <span />
            {matrix.members.map((m) => (
              <span key={`h-${m}`} className="matrix-label mono" title={m}>
                {m.slice(0, 10)}
              </span>
            ))}
            {matrix.members.map((row) => (
              <MatrixRow key={row} row={row} members={matrix.members} matrix={matrix} />
            ))}
          </div>
        </div>
      )}

      {viewGraph && view !== "matrix" && view !== "plain" && (
        <div className="legend">
          <span className="lg-cap">{t("nebula.legend.pages")}</span>
          {typeLegend.map(([type, count]) => (
            <span key={type} className="li">
              <span className="sw" style={{ background: typeColor(type) }} />
              {type} · {count}
            </span>
          ))}
          <span className="lg-cap">{t("nebula.legend.relations")}</span>
          {relationLegend.map(([type, count]) => (
            <button
              key={type}
              type="button"
              className={`li chip-li ${hiddenTypes.has(type) ? "off" : ""}`}
              aria-pressed={!hiddenTypes.has(type)}
              title={t("nebula.legend.toggle")}
              onClick={() =>
                setHiddenTypes((prev) => {
                  const next = new Set(prev);
                  if (next.has(type)) next.delete(type);
                  else next.add(type);
                  return next;
                })
              }
            >
              <span className="sw-line" style={{ borderColor: edgeTypeColor(type) }} />
              {type} · {count}
            </button>
          ))}
          <span className="li">
            <span className="sw-line dashed" style={{ borderColor: GRAPH.edgeNew }} />
            {t("nebula.legend.newEdge")}
          </span>
          <span className="li">
            <span className="sw" style={{ background: GRAPH.red }} />
            {t("nebula.legend.pending")}
          </span>
        </div>
      )}

      {report?.fingerprint && (
        <p className="graph-caption">
          {t("nebula.caption")}: {report.fingerprint}
          {report.generatedAt ? ` · ${report.generatedAt}` : ""}
        </p>
      )}
    </section>
  );
}

function MatrixRow({
  row,
  members,
  matrix,
}: {
  row: string;
  members: string[];
  matrix: {
    edgeSet: Set<string>;
    newSet: Set<string>;
    pending: Set<string>;
    center: string;
  };
}) {
  return (
    <>
      <span className={`matrix-label mono ${matrix.pending.has(row) ? "pending" : ""}`} title={row}>
        {row.slice(0, 10)}
      </span>
      {members.map((col) => {
        const isNew = matrix.newSet.has(row < col ? `${row}||${col}` : `${col}||${row}`);
        const cls =
          row === col
            ? "diag"
            : matrix.edgeSet.has(`${row}→${col}`)
              ? isNew
                ? "edge-new"
                : "edge"
              : "";
        return (
          <span
            key={col}
            className={`matrix-cell ${cls} ${row === matrix.center && matrix.pending.has(col) ? "pending" : ""}`}
            title={`${row} → ${col}`}
          />
        );
      })}
    </>
  );
}
