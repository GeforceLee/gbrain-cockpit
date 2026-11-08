// Mint Audit (v5) design tokens — the SINGLE source of every color the app
// uses, in both worlds (style-review hard constraint: canvas and DOM tokens
// are same-source). CSS consumes the injected `--*` variables; sigma.js and
// any other canvas code imports GRAPH / TERMINAL directly. No color literal
// may appear in a .css file or a component — only here.
//
// Source of truth: internal/mockups/5-approva-audit.html :root (frozen
// 2026-11-04, internal/mockups/README.md §7) for the DOM chrome; the GRAPH
// canvas constants are the Paper Routes skin (2026-11-05 pick: B paper
// atlas base × C direction particles; see internal/mockups/7-nebula-styles.html
// and README §8). A reskin swaps this module's values only.

export const PALETTE = {
  mint: "#CFE8D6",
  ink: "#121210",
  ok: "#2E8C42",
  warn: "#E8A030",
  warnPale: "#F4D89A",
  stop: "#C03A3A",
  phos: "#7BE38B",
  paper: "#FFFFFF",
  /** mint well: doc-raw + matrix diagonal (the graph window has its own GRAPH.bg) */
  canvas: "#DCEDDF",
  /** warn-colored mini-stamp (darker amber for legibility on paper) */
  warnStamp: "#A66E14",
  scrollbar: "#A9C7B1",
} as const;

/** Terminal-material greys of the command block. Skin-independent by design
 *  ("命令块黑底磷绿 = 终端材料语义,不随皮肤") — they are phosphor-screen
 *  derivatives, not Mint Audit derivatives, and survive any future reskin. */
export const TERMINAL = {
  /** caption dim green */
  cap: "#9DB8A0",
  /** caption bright (zh line) */
  capBright: "#CFE3D2",
  /** step body */
  step: "#B9CDBD",
  /** step strong (b) */
  stepStrong: "#E4F1E6",
  /** no-batch footnote */
  mute: "#7E9683",
  /** code well background */
  codeBg: "rgba(123,227,139,.09)",
  /** code well border */
  codeBorder: "rgba(123,227,139,.28)",
  /** copy flash ring */
  flashRing: "rgba(123,227,139,.55)",
} as const;

export const FONTS = {
  display: "'Archivo', 'Noto Sans SC', sans-serif",
  body: "'Hanken Grotesk', 'Noto Sans SC', sans-serif",
  mono: "'Space Mono', 'Roboto Mono', ui-monospace, Menlo, monospace",
} as const;

/** Canvas (sigma.js) palette — Paper Routes skin (2026-11-05 owner pick,
 *  style-review follow-up: B "paper atlas" base × C directional particles).
 *  A light material inside the Mint desk: paper canvas, community-pastel
 *  discs (louvain — page-TYPE colors collapsed on real brains whose visible
 *  pages share one type), always-on ink labels with a paper halo, region
 *  washes, and relation "routes" — thin tinted tracks with flowing
 *  direction particles (gbrain links are directed). Same-source with the
 *  CSS variables below. */
export const GRAPH = {
  /** paper canvas */
  bg: "#FCFDF9",
  ink: "#26291F",
  /** legend swatch: pages carrying pending proposals */
  red: PALETTE.stop,
  /** community palette — assigned by visible-member count, largest first */
  commColors: ["#D98A4A", "#5FA973", "#6E9BD1", "#A583C9", "#D97C8A", "#8A9B5A", "#B8775A"] as readonly string[],
  /**
   * Source palette (按源着色 mode) — same pastel register as commColors;
   * the two modes live behind a toggle and never show at once. Sources are
   * CATEGORICAL (not quantitative): a 100/17 split SHOULD read as two
   * colored worlds. Sources past the palette collapse to ghostColor under
   * one "其他来源" legend aggregate (the page-TYPE collapse lesson,
   * 2026-11-05, applied to the source axis).
   */
  sourceColors: ["#5F8FB0", "#C98B45", "#7D9C5C", "#A0709E", "#C9697C", "#6E8FA5"] as readonly string[],
  /** cross-source relations (a ranking signal upstream): dashed ink, distinct
   *  from both the amber pending dash and the typed route colors */
  crossSource: "#4A4F44",
  crossSourceDash: [2, 4] as readonly number[],
  /** communities/sources past the palette + ungrouped pages: quiet gray */
  ghostColor: "#C4C9BF",
  /** region washes: communities with at least this many members */
  washMin: 4,
  washFill: 0.09,
  washStroke: 0.13,
  washLabel: "rgba(38,41,31,.5)",
  regionFont: "'Archivo'",
  /** overlay labels (sigma's own label renderer is off): ink on paper halo */
  labelInk: "rgba(38,41,31,.85)",
  labelFont: FONTS.body,
  /**
   * Per-relation-type route colors (semantic: color = what the relation IS;
   * the amber dash stays reserved for the pending/un-adjudicated STATE).
   * Keyed by gbrain link_type; live-probed 2026-11-04. Extend when probes
   * surface new types — unknown types fall back to `edgeUnknown`.
   */
  edgeTypes: {
    mentions: "#6B7A70", // sage — A 提到 B (most common, neutral weight)
    cited: "#3F8A55", // green — A 引用 B
    advises: "#96622C", // ochre — A 建议 B (kept apart from dash=pending)
    founded: "#5668AC", // indigo — A 创立 B
  } as Record<string, string>,
  /** untyped / unknown relations */
  edgeUnknown: "#9AA19B",
  /** route track: thin tinted line under the particles */
  trackAlpha: 0.16,
  trackWidth: 1.1,
  /** direction particles: dots flowing source→target with a comet tail */
  particleSpeedMs: 2400,
  particleSize: 2.3,
  particleTail: [0.95, 0.5, 0.25] as readonly number[],
  particleTailGap: 0.022,
  /** above this many visible routes, particles degrade to static chevrons
   *  and the overlay returns to dirty-check idle skipping */
  maxAnimatedEdges: 400,
  /** dream-new relation (amber, dashed) */
  edgeNew: PALETTE.warn,
  edgeNewWidth: 1.8,
  /** hover / selection ring: ink */
  hoverRing: "#26291F",
  /** focus-view hop rings + their captions */
  orbitRing: "rgba(38,41,31,.35)",
  /** pending-page ring (steady — the size pulse stays the motion cue) */
  pendingRing: PALETTE.warn,
  /** neighborhood-focus factor: pages/routes/labels outside the hovered
   *  page's 1-hop set fade to this alpha until the pointer leaves */
  dim: 0.22,
  /** tooltip chrome — light paper readout */
  tipBg: "#FFFFFF",
  tipText: "#26291F",
  tipBorder: "rgba(38,41,31,.22)",
  /**
   * sigma factory-look preset for the 原版 (stock) comparison tab. These are
   * deliberately NOT skin values — the tab exists to show the graph exactly
   * as the library renders it, unskinned.
   */
  stock: {
    node: "#999999",
    edge: "#CCCCCC",
    label: "#000000",
    bg: "#FFFFFF",
  },
} as const;

/** Relation-type route color — shared by the Nebula legend/routes and the
 *  Pages detail relation badges so the two surfaces never disagree. */
export function edgeTypeColor(type: string | undefined): string {
  return (type && GRAPH.edgeTypes[type]) || GRAPH.edgeUnknown;
}

export const EASINGS = {
  /** stamp drop */
  spring: "cubic-bezier(.34, 1.56, .64, 1)",
  /** everything else */
  ease: "cubic-bezier(.23, 1, .32, 1)",
} as const;

/** CSS custom properties injected onto :root at boot (before first render,
 *  so an SPA never flashes unstyled). Values live ONLY here. */
const CSS_VARS: Record<string, string> = {
  "--mint": PALETTE.mint,
  "--ink": PALETTE.ink,
  "--ok": PALETTE.ok,
  "--warn": PALETTE.warn,
  "--warn-pale": PALETTE.warnPale,
  "--stop": PALETTE.stop,
  "--phos": PALETTE.phos,
  "--paper": PALETTE.paper,
  "--canvas": PALETTE.canvas,
  "--warn-stamp": PALETTE.warnStamp,
  "--scrollbar": PALETTE.scrollbar,
  "--f-disp": FONTS.display,
  "--f-body": FONTS.body,
  "--f-mono": FONTS.mono,
  "--spring": EASINGS.spring,
  "--ease": EASINGS.ease,
  "--cmd-cap": TERMINAL.cap,
  "--cmd-cap-bright": TERMINAL.capBright,
  "--cmd-step": TERMINAL.step,
  "--cmd-strong": TERMINAL.stepStrong,
  "--cmd-mute": TERMINAL.mute,
  "--cmd-code-bg": TERMINAL.codeBg,
  "--cmd-code-border": TERMINAL.codeBorder,
  // derived ink alphas (rules, grids, dimmed text) — same-source as the rest
  "--line-faint": "rgba(18,18,16,.05)", // grid paper on white
  "--line-track": "rgba(18,18,16,.15)", // gauge track
  "--line-soft": "rgba(18,18,16,.16)", // selection + soft row rules
  "--line": "rgba(18,18,16,.18)", // row rules
  "--line-dashed": "rgba(18,18,16,.2)", // checklist dashed rules
  "--ink-dim": "rgba(18,18,16,.62)", // meta strip text
  "--white-dim": "rgba(255,255,255,.5)", // audit caption
  // Deep Field graph window (same-source with GRAPH)
  "--graph-bg": GRAPH.bg,
  "--graph-tip-bg": GRAPH.tipBg,
  "--graph-tip-text": GRAPH.tipText,
  "--graph-tip-border": GRAPH.tipBorder,
};

export function applyDesignTokens(
  root: { style: { setProperty(k: string, v: string): void } } = document.documentElement,
): void {
  for (const [name, value] of Object.entries(CSS_VARS)) {
    root.style.setProperty(name, value);
  }
}
