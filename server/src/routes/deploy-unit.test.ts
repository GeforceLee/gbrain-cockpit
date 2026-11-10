import { describe, expect, test } from "bun:test";
import { buildDeployUnitText, DEPLOY_NOTES } from "./deploy-unit";

describe("buildDeployUnitText (0.5.0 deploy-checkup reference text)", () => {
  const BIP_BINDINGS = [
    { source_id: "default", local_path: "/home/dev/gbrain-bip/.gbrain/content/x/default" },
    { source_id: "iuap-apcom-migration", local_path: "/home/dev/bip-gbrain/iuap-apcom-migration" },
    { source_id: "iuap-ap-formula", local_path: "/home/dev/bip-gbrain/iuap-ap-formula" },
    { source_id: "yon-bip", local_path: "/home/dev/bip-gbrain/yon-bip" },
    { source_id: "iuap-apcom-docs", local_path: "/home/dev/bip-gbrain/iuap-apcom-docs" },
  ];

  test("direct-call form: GBRAIN_HOME env + real bin, freshness for all, calibration for non-default", () => {
    const text = buildDeployUnitText({
      cliBin: "gbrain-bip",
      gbrainBin: "/home/dev/.bun/bin/gbrain",
      gbrainHome: "/home/dev/gbrain-bip",
      bindings: BIP_BINDINGS,
    });
    expect(text).toContain("Environment=GBRAIN_HOME=/home/dev/gbrain-bip");
    expect(text).toContain('"/home/dev/.bun/bin/gbrain" dream --source "default" --json');
    expect(text).toContain(
      '"/home/dev/.bun/bin/gbrain" dream --source "yon-bip" --phase propose_takes --phase grade_takes --json',
    );
    // default rides freshness only (its calibration pass would be a no-op)
    expect(text).not.toContain('--source "default" --phase');
    // the owner-deletes-sources disclaimer travels with the text
    expect(text).toContain("never installs");
  });

  test("wrapper form (no direct-call pair): plain bin, no GBRAIN_HOME line", () => {
    const text = buildDeployUnitText({
      cliBin: "gbrain",
      bindings: [{ source_id: "default" }],
    });
    expect(text).toContain('"gbrain" dream --source "default" --json');
    expect(text).not.toContain("Environment=GBRAIN_HOME=");
  });

  test("the single-quote and knowledge comments are pinned in the text", () => {
    const text = buildDeployUnitText({ cliBin: "gbrain", bindings: BIP_BINDINGS });
    expect(text).toContain("single-quoted");
    expect(text).toContain("repo_path");
    expect(text).toContain("100 pages");
    expect(text).toContain("WHOLE brain");
    expect(text).toContain("cron_gbrain_home");
    // bash -c payload is wrapped in single quotes exactly once per segment
    expect(text.match(/bash -c '/)).toHaveLength(1);
  });

  test("DEPLOY_NOTES is the complete five-note oracle", () => {
    expect([...DEPLOY_NOTES]).toEqual([
      "repo-path-two-locks",
      "systemd-quoting",
      "propose-window",
      "grade-window-global",
      "cron-not-systemd",
    ]);
  });
});
