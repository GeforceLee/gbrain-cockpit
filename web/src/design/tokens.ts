// Mint Audit (v5) design tokens — the SINGLE source of every color the app
// uses, in both worlds (style-review hard constraint: canvas and DOM tokens
// are same-source). CSS consumes the injected `--*` variables; sigma.js and
// any other canvas code imports GRAPH / TERMINAL directly. No color literal
// may appear in a .css file or a component — only here.
//
// Source of truth: internal/mockups/5-approva-audit.html :root (frozen
// 2026-11-04, internal/mockups/README.md §7) for the DOM chrome; the GRAPH
// canvas constants are the Deep Field skin picked in the 2026-11-04 style
// review (candidate A; B/C kept in that session's comparison mockup). A
// reskin swaps this module's values only.

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

/** Canvas (sigma.js) palette — Deep Field skin, the owner pick (2026-11-04)
 *  from the three-candidate style review (runner-ups Paper Atlas / Blueprint
 *  live in that session's mockup only). The graph is the app's second dark
 *  material — like the terminal command block it sits inside the light Mint
 *  Audit desk as an inset observation window. Same-source with the CSS
 *  variables below; the DOM chrome around the window stays Mint Audit. */
export const GRAPH = {
  /** observation-window background */
  bg: "#10151C",
  /** legend swatch: pages carrying pending proposals */
  red: PALETTE.stop,
  /** luminous page-type roles (deterministic rotation by type hash) */
  typeRoles: ["#FFB454", "#6FD9A8", "#8FB8F2", "#C792EA", "#F2779A"] as readonly string[],
  /** untyped pages: dim slate */
  ghost: "#5C6672",
  /** canvas labels */
  labelColor: "#D6DFE7",
  labelFont: FONTS.body,
  /**
   * Per-relation-type edge colors (semantic: color = what the relation IS;
   * the amber dash stays reserved for the pending/un-adjudicated STATE).
   * Keyed by gbrain link_type; live-probed 2026-11-04. Extend when probes
   * surface new types — unknown types fall back to `edgeUnknown`.
   */
  edgeTypes: {
    mentions: "#9FB4A8", // sage — A 提到 B (most common, neutral weight)
    cited: "#5FD98A", // luminous green — A 引用 B
    advises: "#E0A25E", // amber-ochre — A 建议 B (kept apart from dash=pending)
    founded: "#8FA3E8", // periwinkle — A 创立 B
  } as Record<string, string>,
  /** untyped / unknown relations */
  edgeUnknown: "rgba(200,210,205,.32)",
  /** typed-edge opacity on the dark window */
  edgeAlpha: 0.45,
  edgeWidth: 1.2,
  /** dream-new edge (amber, dashed) */
  edgeNew: PALETTE.warn,
  edgeNewWidth: 1.8,
  /** hover / selection ring */
  hoverRing: "rgba(255,255,255,.78)",
  /** focus-view hop rings + their captions */
  orbitRing: "rgba(154,170,182,.6)",
  /** pending-page ring (steady — the size pulse stays the motion cue) */
  pendingRing: PALETTE.warn,
  /** neighborhood-focus factor: nodes/edges/labels outside the hovered
   *  page's 1-hop set fade to this alpha until the pointer leaves */
  dim: 0.12,
  /** glow sprite: radius as a multiple of node size */
  glowRadius: 2.6,
  /** corner vignette wash */
  vignette: "rgba(0,0,0,.32)",
  vignetteClear: "rgba(0,0,0,0)",
  /** tooltip chrome — dark readout, terminal family */
  tipBg: "#1A222D",
  tipText: "#DCE5EC",
  tipBorder: "rgba(255,255,255,.16)",
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
