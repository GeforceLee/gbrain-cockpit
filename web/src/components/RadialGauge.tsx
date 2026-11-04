import { useEffect, useState } from "react";

// Radial gauge — Maple geometry, Mint Audit ink-edge restyle: 128px, r54,
// stroke-width 9, butt caps, a 78% arc rotated 126deg, mono readout. The arc
// animates in via stroke-dashoffset transition (killed by .rm).

const R = 54;
const CIRC = 2 * Math.PI * R; // 339.29
const ARC = CIRC * 0.78;

export function RadialGauge({
  display,
  frac,
  unit,
  color,
  label,
}: {
  /** pre-formatted readout (mono, tabular) */
  display: string;
  /** 0..1 fill of the arc */
  frac: number;
  unit?: string;
  /** stroke color — pass a PALETTE value so canvas/DOM stay same-source */
  color: string;
  label: string;
}) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setMounted(true));
    return () => cancelAnimationFrame(id);
  }, []);

  const clamped = Math.max(0, Math.min(1, frac));
  const offset = mounted ? ARC * (1 - clamped) : ARC;

  return (
    <div className="gauge" role="img" aria-label={label}>
      <svg width="128" height="128" viewBox="0 0 128 128" aria-hidden="true">
        <circle
          cx="64"
          cy="64"
          r={R}
          fill="none"
          stroke="var(--line-track)"
          strokeWidth="3"
        />
        <circle
          className="arc"
          cx="64"
          cy="64"
          r={R}
          fill="none"
          stroke={color}
          strokeWidth="9"
          strokeDasharray={`${ARC} ${CIRC}`}
          strokeDashoffset={offset}
        />
      </svg>
      <div className="read">
        <span className="v">{display}</span>
        {unit ? <span className="u">{unit}</span> : null}
      </div>
    </div>
  );
}
