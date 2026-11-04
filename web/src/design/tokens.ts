// Mint Audit (v5) design tokens — the SINGLE source of every color the app
// uses, in both worlds (style-review hard constraint: canvas and DOM tokens
// are same-source). CSS consumes the injected `--*` variables; sigma.js and
// any other canvas code imports GRAPH / TERMINAL directly. No color literal
// may appear in a .css file or a component — only here.
//
// Source of truth: internal/mockups/5-approva-audit.html :root + canvas
// constants (frozen 2026-11-04, internal/mockups/README.md §7). The backup
// skin (v6 maple-care) would swap this module's values only.

export const PALETTE = {
  mint: "#CFE8D6",
  ink: "#121210",
  ok: "#2E8C42",
  warn: "#E8A030",
  warnPale: "#F4D89A",
  stop: "#C03A3A",
  phos: "#7BE38B",
  paper: "#FFFFFF",
  /** graph-paper canvas background (one step deeper than mint) */
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

/** Canvas (sigma.js) palette — same-source with the CSS variables above. */
export const GRAPH = {
  bg: PALETTE.canvas,
  ink: PALETTE.ink,
  green: PALETTE.ok,
  amber: PALETTE.warn,
  red: PALETTE.stop,
  /** normal edge */
  edge: "rgba(18,18,16,.18)",
  edgeWidth: 1,
  /** dream-new edge (amber, dashed) */
  edgeNew: PALETTE.warn,
  edgeNewWidth: 1.8,
  /**
   * Per-relation-type edge colors (semantic: color = what the relation IS;
   * the amber dash stays reserved for the pending/un-adjudicated STATE).
   * Keyed by gbrain link_type; live-probed 2026-11-04. Extend when probes
   * surface new types — unknown types fall back to `edgeUnknown`.
   */
  edgeTypes: {
    mentions: "#43524B", // graphite — A 提到 B (most common, neutral weight)
    cited: "#2E8C42", // green — A 引用 B
    advises: "#9C5F1B", // dark rust — A 建议 B (kept apart from amber=new)
    founded: "#4A5FB5", // indigo — A 创立 B
  } as Record<string, string>,
  /** untyped / unknown relations */
  edgeUnknown: "rgba(18,18,16,.35)",
  /**
   * sigma factory-look preset for the 原版 (stock) comparison tab. These are
   * deliberately NOT Mint Audit brand values — the tab exists to show the
   * graph exactly as the library renders it, unskinned.
   */
  stock: {
    node: "#999999",
    edge: "#CCCCCC",
    label: "#000000",
    bg: "#FFFFFF",
  },
  /** community hull stroke */
  hull: "rgba(18,18,16,.55)",
  /** ghost node fill (low-trust / unknown type) */
  ghost: "rgba(18,18,16,.35)",
  /** grid paper on canvas */
  gridLine: "rgba(18,18,16,.06)",
  labelFont: "Space Mono",
  regionFont: "Archivo",
} as const;

export const FONTS = {
  display: "'Archivo', 'Noto Sans SC', sans-serif",
  body: "'Hanken Grotesk', 'Noto Sans SC', sans-serif",
  mono: "'Space Mono', 'Roboto Mono', ui-monospace, Menlo, monospace",
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
  "--line-grid": "rgba(18,18,16,.06)", // grid paper on canvas
  "--line-track": "rgba(18,18,16,.15)", // gauge track
  "--line-soft": "rgba(18,18,16,.16)", // selection + soft row rules
  "--line": "rgba(18,18,16,.18)", // row rules
  "--line-dashed": "rgba(18,18,16,.2)", // checklist dashed rules
  "--ink-dim": "rgba(18,18,16,.62)", // meta strip text
  "--white-dim": "rgba(255,255,255,.5)", // audit caption
};

export function applyDesignTokens(
  root: { style: { setProperty(k: string, v: string): void } } = document.documentElement,
): void {
  for (const [name, value] of Object.entries(CSS_VARS)) {
    root.style.setProperty(name, value);
  }
}
