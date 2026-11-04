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
// Paradigms (frozen decision): 星域 starfield (default) / 轨道 orbit (click a
// node) / 矩阵 matrix (neighborhood widget). FA2 layout coordinates are frozen
// per graph fingerprint (localStorage) so dream diffs stay comparable; labels
// render on sigma's canvas (native canvas text — immune to HTML injection);
// node colors map page type, node size maps degree; dream-new edges (the SAME
// data as the Inbox edge-proposals queue) paint amber; nodes with pending
// proposals pulse. All colors come from the same-source GRAPH palette.
//
// Structure: `baseData` (full graph + frozen layout + communities + pending
// sets) never depends on selection, so picking nodes does NOT rebuild sigma;
// `viewGraph` is the per-paradigm graphology instance sigma mounts.

type ViewKind = "field" | "orbit" | "matrix";

const VIEW_KEY = "cockpit.nebula.view";
const NOISE_KEY = "cockpit.nebula.noise";
const LAYOUT_PREFIX = "cockpit.nebula.layout.";
const NOISE_DEGREE = 3;
const MATRIX_MAX = 24;

/** deterministic role rotation by page type (cluster colors of the mockup) */
const TYPE_ROLES = [
  GRAPH.green,
  GRAPH.amber,
  GRAPH.ink,
  "#FFFFFF", // hollow: white fill
  GRAPH.ghost,
] as const;

function typeColor(type: string | undefined): string {
  if (!type) return GRAPH.ghost;
  let h = 0;
  for (let i = 0; i < type.length; i++) h = ((h << 5) - h + type.charCodeAt(i)) | 0;
  return TYPE_ROLES[Math.abs(h) % TYPE_ROLES.length]!;
}

function nodeRadius(degree: number, orbit: boolean): number {
  return (2.5 + Math.sqrt(degree) * 1.9) * (orbit ? 1.15 : 1);
}

/** Andrew monotone chain convex hull, ported from the frozen mockup */
function convexHull(points: [number, number][]): [number, number][] {
  if (points.length < 3) return points;
  const pts = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: [number, number], a: [number, number], b: [number, number]) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: [number, number][] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: [number, number][] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i]!;
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, p) <= 0) upper.pop();
    upper.push(p);
  }
  upper.pop();
  lower.pop();
  return lower.concat(upper);
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
    return v === "orbit" || v === "matrix" ? v : "field";
  });
  const [noise, setNoise] = useState(() => localStorage.getItem(NOISE_KEY) === "1");
  const [selected, setSelected] = useState<string | null>(null);
  const [locate, setLocate] = useState("");

  const wrapRef = useRef<HTMLDivElement>(null);
  const mountRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const sigmaRef = useRef<Sigma | null>(null);
  const mouseRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  // hovered node (overlay draws the mockup's 2.5px ink ring at r+3.5 for it)
  const hoveredRef = useRef<string | null>(null);
  // selection changes rebuild the graph instance (orbit filtering); keeping
  // the last camera state across remounts avoids snapping back to overview
  const cameraRef = useRef<{ x: number; y: number; ratio: number; angle: number } | null>(null);

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

  // dream-new edges share the Inbox queue's data (same data, two surfaces)
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

    // communities (hulls + matrix ordering) — decorative on failure
    try {
      louvain.assign(full);
    } catch {
      // leave unassigned; hulls simply won't draw
    }

    const degree = new Map<string, number>();
    full.forEachNode((node) => degree.set(node, full.degree(node)));
    return { nodes, edges, fingerprint, full, degree, pending, newEdgeSet };
  }, [report, proposalEdges]);

  // --- per-paradigm graph sigma mounts ------------------------------------------

  const viewGraph = useMemo(() => {
    if (!baseData) return null;
    const { nodes, full, degree, pending, newEdgeSet, fingerprint } = baseData;

    let members: Set<string> | null = null;
    if (view === "orbit" && selected && full.hasNode(selected)) {
      members = new Set(hops(full, selected, 2).keys());
    }

    const graph = new Graph({ multi: false, type: "undirected" });
    for (const n of nodes) {
      const slug = n.slug;
      if (members && !members.has(slug)) continue;
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
        forceLabel: pending.has(slug),
        hidden:
          view === "field" && noise && deg < NOISE_DEGREE && !pending.has(slug),
        // sigma 4 label styling (per-node): Space Mono, ink, tabular culling
        labelFont: GRAPH.labelFont,
        labelSize: 11,
        labelColor: GRAPH.ink,
      });
    }
    // dream-new edges do NOT enter the sigma graph: sigma's edge program
    // cannot dash, so the overlay canvas draws them dashed amber (mockup
    // recipe). Their endpoints still pulse, and the same data lives in the
    // Inbox edge queue. Trade-off: no hover tooltip on these overlay edges.
    const newEdges: { source: string; target: string }[] = [];
    for (const e of baseData.edges) {
      if (!graph.hasNode(e.source) || !graph.hasNode(e.target)) continue;
      const key = e.source < e.target ? `${e.source}||${e.target}` : `${e.target}||${e.source}`;
      if (newEdgeSet.has(key)) {
        newEdges.push({ source: e.source, target: e.target });
        continue;
      }
      if (graph.hasEdge(e.source, e.target)) continue;
      graph.addEdge(e.source, e.target, {
        link_type: e.link_type,
        color: GRAPH.edge,
        size: GRAPH.edgeWidth,
      });
    }
    return { graph, pending, newEdges, fingerprint };
  }, [baseData, view, noise, selected]);

  // --- sigma lifecycle -----------------------------------------------------------

  useEffect(() => {
    if (!viewGraph || view === "matrix" || !mountRef.current) return;
    const { graph, pending } = viewGraph;

    // sigma 4: label font/color/size are per-node attributes; global settings
    // keep the density/grid culling and the size threshold below which nodes
    // render without labels (only visible labels — ARCHITECTURE §6).
    const sigma = new Sigma(graph, mountRef.current, {
      settings: {
        labelDensity: 0.6,
        labelGridCellSize: 100,
        labelRenderedSizeThreshold: 6,
        minCameraRatio: 0.02,
        maxCameraRatio: 12,
      },
    });
    sigmaRef.current = sigma;

    // orbit mount: center on the selected node; otherwise restore the camera
    if (view === "orbit" && selected && graph.hasNode(selected)) {
      const attrs = graph.getNodeAttributes(selected);
      sigma.getCamera().setState({ x: attrs.x, y: attrs.y, ratio: 0.4 });
    } else if (cameraRef.current) {
      sigma.getCamera().setState(cameraRef.current);
    }

    sigma.on("clickNode", ({ node }) => {
      setSelected(node);
      if (view !== "orbit") {
        setView("orbit");
        localStorage.setItem(VIEW_KEY, "orbit");
      }
    });
    sigma.on("clickStage", () => setSelected(null));
    sigma.on("enterNode", ({ node }) => {
      hoveredRef.current = node;
      const attrs = graph.getNodeAttributes(node);
      showTip(
        pending.has(node)
          ? `${node} · deg ${attrs.degree} · ${t("nebula.tipPending")}`
          : `${node} · deg ${attrs.degree}`,
      );
    });
    sigma.on("leaveNode", () => {
      hoveredRef.current = null;
      hideTip();
    });
    sigma.on("enterEdge", ({ edge }) => {
      const attrs = graph.getEdgeAttributes(edge);
      const [a, b] = graph.extremities(edge);
      showTip(`${attrs.link_type ?? "?"} · ${a} → ${b}`);
    });
    sigma.on("leaveEdge", hideTip);

    return () => {
      cameraRef.current = sigma.getCamera().getState();
      sigma.kill();
      sigmaRef.current = null;
      hideTip();
    };
  }, [viewGraph, view, selected, t]);

  // selection emphasis: forceLabel + bigger size (no rebuild — attrs only)
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
  }, [selected, viewGraph, view]);

  // pending-node pulse: slow size oscillation (reduced-motion shows steady)
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
    }, 700);
    return () => clearInterval(timer);
  }, [viewGraph, view, selected]);

  // --- overlay canvas: hulls + node ink strokes + dashed new edges + rings ------
  // sigma 4 has no dashed-edge or node-stroke primitives, so the overlay draws
  // them each frame, camera-synced through sigma.graphToViewport/scaleSize.

  useEffect(() => {
    if (!viewGraph || view === "matrix") return;
    const { graph, newEdges } = viewGraph;

    // hulls in GRAPH coordinates + per-community dominant type (region name)
    const byCommunity = new Map<number, [number, number][]>();
    const counts = new Map<number, number>();
    const typeHist = new Map<number, Map<string, number>>();
    graph.forEachNode((node, attrs) => {
      if (attrs.hidden) return;
      const c = typeof attrs.community === "number" ? attrs.community : -1;
      const list = byCommunity.get(c);
      if (list) list.push([attrs.x, attrs.y]);
      else byCommunity.set(c, [[attrs.x, attrs.y]]);
      counts.set(c, (counts.get(c) ?? 0) + 1);
      const type = typeof attrs.type === "string" && attrs.type ? attrs.type : null;
      if (type) {
        const hist = typeHist.get(c) ?? new Map<string, number>();
        hist.set(type, (hist.get(type) ?? 0) + 1);
        typeHist.set(c, hist);
      }
    });
    const hulls = new Map<number, [number, number][]>();
    for (const [c, points] of byCommunity) {
      if (points.length >= 3) hulls.set(c, convexHull(points));
    }
    // semantic region name (mockup: 项目群 · 12): the community's dominant
    // page type + member count; communities without typed members fall back
    // to the numeric id
    const regionName = (c: number): string => {
      const hist = typeHist.get(c);
      let dominant: string | null = null;
      let best = 0;
      if (hist) {
        for (const [type, n] of hist) {
          if (n > best) {
            best = n;
            dominant = type;
          }
        }
      }
      const count = counts.get(c) ?? 0;
      return dominant ? `${dominant} · ${count}` : `·${c} ${count}`;
    };

    // NOTE: node strokes read attributes LIVE each frame (not a setup-time
    // snapshot) because the pulse and selection effects mutate `size`.

    let raf = 0;
    let running = true;
    const onVisibility = () => {
      running = !document.hidden;
      if (running) loop();
    };
    document.addEventListener("visibilitychange", onVisibility);

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
      if (overlay.width !== Math.round(w * dpr) || overlay.height !== Math.round(h * dpr)) {
        overlay.width = Math.round(w * dpr);
        overlay.height = Math.round(h * dpr);
      }
      const ctx = overlay.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      // community hulls (dashed ink) + region labels
      ctx.setLineDash([5, 4]);
      ctx.strokeStyle = GRAPH.hull;
      ctx.lineWidth = 1.5;
      for (const [c, hull] of hulls) {
        if (hull.length < 3) continue;
        ctx.beginPath();
        hull.forEach((p, i) => {
          const v = sigma.graphToViewport({ x: p[0], y: p[1] });
          if (i === 0) ctx.moveTo(v.x, v.y);
          else ctx.lineTo(v.x, v.y);
        });
        ctx.closePath();
        ctx.stroke();
        const anchor = sigma.graphToViewport({ x: hull[0]![0], y: hull[0]![1] });
        ctx.setLineDash([]);
        ctx.font = `700 11px ${GRAPH.regionFont}, "Noto Sans SC", sans-serif`;
        ctx.fillStyle = GRAPH.hull;
        ctx.fillText(regionName(c), anchor.x + 6, anchor.y - 6);
        ctx.setLineDash([5, 4]);
      }
      ctx.setLineDash([]);

      // dream-new edges: amber dashed [6,3], lw 1.8 (mockup recipe) — drawn
      // here because sigma's edge program cannot dash
      ctx.setLineDash([6, 3]);
      ctx.strokeStyle = GRAPH.edgeNew;
      ctx.lineWidth = GRAPH.edgeNewWidth;
      for (const e of newEdges) {
        if (!graph.hasNode(e.source) || !graph.hasNode(e.target)) continue;
        const a = graph.getNodeAttributes(e.source);
        const b = graph.getNodeAttributes(e.target);
        if (a.hidden || b.hidden) continue;
        const va = sigma.graphToViewport({ x: a.x, y: a.y });
        const vb = sigma.graphToViewport({ x: b.x, y: b.y });
        ctx.beginPath();
        ctx.moveTo(va.x, va.y);
        ctx.lineTo(vb.x, vb.y);
        ctx.stroke();
      }
      ctx.setLineDash([]);

      // node ink strokes (mockup: solid/hollow nodes carry a 1.5px ink stroke;
      // ghost nodes are fill-only) — radius via sigma.scaleSize so zoom,
      // pulse oscillation and selection bumps all track the rendered size
      ctx.strokeStyle = GRAPH.ink;
      ctx.lineWidth = 1.5;
      graph.forEachNode((node, attrs) => {
        if (attrs.hidden || attrs.color === GRAPH.ghost) return;
        const pos = sigma.graphToViewport({ x: attrs.x, y: attrs.y });
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, sigma.scaleSize(attrs.size), 0, Math.PI * 2);
        ctx.stroke();
      });

      // hover/selected emphasis ring: ink, lw 2.5, at radius + 3.5 (mockup)
      const focus = hoveredRef.current ?? selected;
      if (focus && graph.hasNode(focus)) {
        const attrs = graph.getNodeAttributes(focus);
        if (!attrs.hidden) {
          const pos = sigma.graphToViewport({ x: attrs.x, y: attrs.y });
          ctx.lineWidth = 2.5;
          ctx.beginPath();
          ctx.arc(pos.x, pos.y, sigma.scaleSize(attrs.size) + 3.5, 0, Math.PI * 2);
          ctx.stroke();
        }
      }

      // orbit rings (1/2 hop) around the selected node
      if (view === "orbit" && selected && graph.hasNode(selected)) {
        const attrs = graph.getNodeAttributes(selected);
        const center = sigma.graphToViewport({ x: attrs.x, y: attrs.y });
        ctx.setLineDash([6, 5]);
        for (const frac of [0.18, 0.34]) {
          const r = frac * Math.min(w, h);
          ctx.strokeStyle = GRAPH.hull;
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.arc(center.x, center.y, r, 0, Math.PI * 2);
          ctx.stroke();
          ctx.font = `400 10px ${GRAPH.labelFont}`;
          ctx.fillStyle = GRAPH.hull;
          ctx.fillText(frac < 0.3 ? "1 hop" : "2 hop", center.x + r * 0.7, center.y - r * 0.7);
        }
        ctx.setLineDash([]);
      }
    }
    loop();
    return () => {
      running = false;
      cancelAnimationFrame(raf);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [viewGraph, view, selected]);

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

  // --- locate (graph search → orbit + drawer) ---------------------------------------

  function runLocate() {
    const q = locate.trim().toLowerCase();
    if (!q || !baseData) return;
    const hit = baseData.full
      .nodes()
      .find((n) => n.toLowerCase().includes(q));
    if (!hit) return;
    setSelected(hit);
    setView("orbit");
    localStorage.setItem(VIEW_KEY, "orbit");
    const sigma = sigmaRef.current;
    if (sigma) {
      const attrs = baseData.full.getNodeAttributes(hit);
      const camera = sigma.getCamera();
      if (document.documentElement.classList.contains("rm")) {
        camera.setState({ x: attrs.x, y: attrs.y, ratio: 0.35 });
      } else {
        camera.animate({ x: attrs.x, y: attrs.y, ratio: 0.35 }, { duration: 500 });
      }
    }
  }

  function switchView(next: ViewKind) {
    setView(next);
    localStorage.setItem(VIEW_KEY, next);
    if (next !== "orbit") setSelected(null);
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
    const { full, newEdgeSet, pending } = baseData;
    const center = selected && full.hasNode(selected) ? selected : (full.nodes()[0] ?? null);
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

  return (
    <section className="panel nebula">
      <div className="nebula-head">
        <div>
          <h2>{t("panel.nebula.title")}</h2>
          <p className="self">{t("panel.nebula.desc")}</p>
        </div>
        <div className="nebula-tools">
          <div className="vtabs" role="group" aria-label={t("nebula.view.label")}>
            {(["field", "orbit", "matrix"] as const).map((v) => (
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
          className="graph-wrap"
          ref={wrapRef}
          onMouseMove={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            mouseRef.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
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
              <h5>{selected}</h5>
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
              {onOpenPage && (
                <button
                  type="button"
                  className="linkish drawer-open"
                  onClick={() => onOpenPage(selected)}
                >
                  {t("nebula.drawer.openPage")}
                </button>
              )}
            </div>
          ) : null}
        </div>
      )}

      {matrix && (
        <div className="graph-wrap matrix-wrap">
          <p className="graph-caption">
            {t("nebula.matrix.caption")} · {matrix.members.length} × {matrix.members.length}
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

      {viewGraph && view !== "matrix" && (
        <div className="legend">
          {typeLegend.map(([type, count]) => (
            <span key={type} className="li">
              <span className="sw" style={{ background: typeColor(type) }} />
              {type} · {count}
            </span>
          ))}
          <span className="li">
            <span className="sw" style={{ background: GRAPH.edgeNew }} />
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
