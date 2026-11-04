import { Fragment } from "react";

// Trust chain widget: the pipeline a proposal traveled —
// 采集 → 抽取 → 拦截 → owner → 生效. Nodes before `active` are done (green),
// the active stage is amber, later stages wait at reduced opacity.

export function TrustChain({ stages, active }: { stages: number; active: number }) {
  return (
    <span className="chain" aria-hidden="true">
      {Array.from({ length: stages }, (_, i) => (
        <Fragment key={i}>
          {i > 0 && <span className={`link ${i <= active ? "" : "wait"}`} />}
          <span
            className={`node ${i < active ? "done" : i === active ? "now" : "wait"}`}
          >
            {i + 1}
          </span>
        </Fragment>
      ))}
    </span>
  );
}
