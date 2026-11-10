import { describe, expect, test } from "bun:test";
import {
  ADJUDICATION_CHANNELS,
  ERROR_CODES,
  FEDERATED_LIST_RE,
  MANAGEMENT_CHANNELS,
  OWNER_BIN_RE,
  PROFILE_ID_RE,
  SOURCE_ID_RE,
  authClientsListCommand,
  authRescopeCommand,
  dreamCalibrationCommand,
  normalizeDoctorCheck,
  authRevokeClientCommand,
  buildGraphKey,
  contradictionAcceptCommand,
  contradictionRejectCommand,
  edgeAcceptCommand,
  isValidSourceId,
  trustConfirmCommand,
  trustDropCommand,
  trustExplainCommand,
  trustReleaseCommand,
  validateFederatedReadList,
  worstStatus,
  type AdjudicationAction,
  type Channel,
  type ManagementAction,
} from "./index";

const VALID_CHANNELS: readonly Channel[] = [
  "mcp",
  "cli-whitelist",
  "copy-command",
];

describe("ADJUDICATION_CHANNELS", () => {
  test("every action maps to exactly one valid channel", () => {
    const actions = Object.keys(ADJUDICATION_CHANNELS) as AdjudicationAction[];
    expect(actions.length).toBeGreaterThan(0);
    for (const action of actions) {
      const channel = ADJUDICATION_CHANNELS[action];
      expect(VALID_CHANNELS).toContain(channel);
    }
  });

  test("owner-presence actions never leave the copy-command channel", () => {
    // AGENTS.md non-negotiable #1 — the trust foundation of the tool.
    expect(ADJUDICATION_CHANNELS["trust.proposal.accept"]).toBe(
      "copy-command",
    );
    expect(ADJUDICATION_CHANNELS["held-write.release"]).toBe("copy-command");
  });

  test("no duplicate actions (guaranteed by the type, checked at runtime too)", () => {
    const actions = Object.keys(ADJUDICATION_CHANNELS);
    expect(new Set(actions).size).toBe(actions.length);
  });
});

describe("MANAGEMENT_CHANNELS", () => {
  test("every management action maps to exactly one valid channel", () => {
    const actions = Object.keys(MANAGEMENT_CHANNELS) as ManagementAction[];
    expect(actions.length).toBeGreaterThan(0);
    for (const action of actions) {
      expect(VALID_CHANNELS).toContain(MANAGEMENT_CHANNELS[action]);
    }
  });

  test("stays disjoint from the adjudication matrix (one action, one matrix)", () => {
    const adjudication = new Set(Object.keys(ADJUDICATION_CHANNELS));
    for (const action of Object.keys(MANAGEMENT_CHANNELS)) {
      expect(adjudication.has(action)).toBe(false);
    }
  });

  test("trust-elevating verbs can never appear (owner-presence red line)", () => {
    const actions = Object.keys(MANAGEMENT_CHANNELS).join(" ");
    expect(actions).not.toContain("trust");
    expect(actions).not.toContain("held-write");
  });
});

describe("validateFederatedReadList", () => {
  test("dedupes and accepts upstream-shaped ids", () => {
    expect(
      validateFederatedReadList([
        "iuap-apcom-docs",
        "yon-bip",
        "iuap-apcom-docs",
      ]),
    ).toEqual(["iuap-apcom-docs", "yon-bip"]);
  });

  test("rejects shapes upstream assertValidSourceId would refuse", () => {
    expect(() => validateFederatedReadList(["-lead"])).toThrow();
    expect(() => validateFederatedReadList(["trail-"])).toThrow();
    expect(() => validateFederatedReadList(["a--b"])).toThrow();
    expect(() => validateFederatedReadList(["UPPER"])).toThrow();
    expect(() => validateFederatedReadList(["has space"])).toThrow();
    expect(() => validateFederatedReadList(["x".repeat(33)])).toThrow();
    expect(() => validateFederatedReadList([])).toThrow();
  });

  test("bounds the list size and total length", () => {
    expect(() =>
      validateFederatedReadList(Array.from({ length: 51 }, (_, i) => `s${i}`)),
    ).toThrow();
    expect(() =>
      validateFederatedReadList(
        Array.from({ length: 20 }, (_, i) => `${i}`.padEnd(20, "a")),
      ),
    ).toThrow(); // 20 unique ×20 chars + commas > 300
  });

  test("FEDERATED_LIST_RE mirrors the validator on joined form", () => {
    expect(FEDERATED_LIST_RE.test("a-b,c,def")).toBe(true);
    expect(FEDERATED_LIST_RE.test("a-b,,c")).toBe(false);
    expect(FEDERATED_LIST_RE.test("-a,b")).toBe(false);
  });
});

describe("authRescopeCommand", () => {
  const clientId =
    "gbrain_cl_489f6ae02796baf04d3bbb080308b39ec98d8991e1cc9597ed00b8ece4c2c7c9";

  test("builds the replace-semantics command from a validated list", () => {
    expect(authRescopeCommand("gbrain", clientId, ["a", "b-c"])).toBe(
      `gbrain auth rescope --client ${clientId} --federated-read a,b-c`,
    );
  });

  test("refuses bad bins, bad client ids and bad source shapes", () => {
    expect(() => authRescopeCommand("gbrain;rm", clientId, ["a"])).toThrow();
    expect(() => authRescopeCommand("gbrain", "cl_abc", ["a"])).toThrow();
    expect(() => authRescopeCommand("gbrain", clientId, ["--flag"])).toThrow();
  });
});

describe("ERROR_CODES", () => {
  test("are unique", () => {
    expect(new Set(ERROR_CODES).size).toBe(ERROR_CODES.length);
  });
});

describe("worstStatus", () => {
  test("down beats degraded beats ok", () => {
    expect(worstStatus("ok", "degraded", "down")).toBe("down");
    expect(worstStatus("ok", "degraded")).toBe("degraded");
    expect(worstStatus("ok", "ok")).toBe("ok");
    expect(worstStatus()).toBe("ok");
  });
});

describe("PROFILE_ID_RE", () => {
  test("accepts lowercase kebab ids and rejects anything else", () => {
    expect(PROFILE_ID_RE.test("default")).toBe(true);
    expect(PROFILE_ID_RE.test("atlas-b")).toBe(true);
    expect(PROFILE_ID_RE.test("b2")).toBe(true);
    expect(PROFILE_ID_RE.test("Atlas")).toBe(false); // uppercase
    expect(PROFILE_ID_RE.test("-lead")).toBe(false); // leading dash
    expect(PROFILE_ID_RE.test("a".repeat(33))).toBe(false); // too long
    expect(PROFILE_ID_RE.test("a b")).toBe(false); // whitespace
    expect(PROFILE_ID_RE.test("a/b")).toBe(false); // slash — must stay URL/header/map-safe
    expect(PROFILE_ID_RE.test("../etc")).toBe(false);
    expect(PROFILE_ID_RE.test("")).toBe(false);
  });
});

describe("SOURCE_ID_RE / isValidSourceId", () => {
  test("accepts real source ids", () => {
    expect(isValidSourceId("default")).toBe(true);
    expect(isValidSourceId("main")).toBe(true);
    expect(isValidSourceId("iuap-apcom-migration")).toBe(true);
    expect(isValidSourceId("repo.v2")).toBe(true);
  });
  test("rejects reserved sentinels, slashes and shape violations", () => {
    expect(isValidSourceId("__all__")).toBe(false); // upstream cross-source wildcard
    expect(isValidSourceId("__x")).toBe(false); // dunder namespace is reserved
    expect(SOURCE_ID_RE.test("a/b")).toBe(false); // would corrupt graph keys
    expect(SOURCE_ID_RE.test("a b")).toBe(false);
    expect(SOURCE_ID_RE.test("")).toBe(false);
    expect(SOURCE_ID_RE.test("/x")).toBe(false);
  });
});

describe("OWNER_BIN_RE", () => {
  test("accepts bare command names and absolute paths", () => {
    expect(OWNER_BIN_RE.test("gbrain")).toBe(true);
    expect(OWNER_BIN_RE.test("gbrain-bip")).toBe(true);
    expect(OWNER_BIN_RE.test("brain_2")).toBe(true);
    expect(OWNER_BIN_RE.test("/usr/local/bin/gbrain-bip")).toBe(true);
    expect(OWNER_BIN_RE.test("/home/dev/bin/brainb")).toBe(true);
  });
  test("rejects shell-hostile shapes (this string gets pasted into a shell)", () => {
    expect(OWNER_BIN_RE.test("./gbrain")).toBe(false); // relative path resolves against server cwd
    expect(OWNER_BIN_RE.test("-evil")).toBe(false); // leading dash parses as a flag
    expect(OWNER_BIN_RE.test("my gbrain")).toBe(false); // whitespace breaks the paste AND argv
    expect(OWNER_BIN_RE.test("gbrain;rm")).toBe(false); // metachars
    expect(OWNER_BIN_RE.test("gbrain$(x)")).toBe(false);
    expect(OWNER_BIN_RE.test("Gbrain")).toBe(false); // names stay lowercase kebab by convention
    expect(OWNER_BIN_RE.test("")).toBe(false);
  });
});

describe("owner command builders", () => {
  const bin = "gbrain-bip";
  test("render the exact command the owner must run on that brain host", () => {
    expect(trustConfirmCommand(bin, "tp42")).toBe("gbrain-bip trust confirm tp42");
    expect(trustReleaseCommand(bin, "h7")).toBe("gbrain-bip trust release h7");
    expect(trustDropCommand("gbrain", "f12")).toBe("gbrain trust drop f12");
    expect(trustExplainCommand(bin, "a3")).toBe("gbrain-bip trust explain a3");
    expect(edgeAcceptCommand(bin, "12345")).toBe(
      "gbrain-bip edge-proposals accept 12345",
    );
    expect(contradictionAcceptCommand(bin, "7")).toBe(
      "gbrain-bip decide proposals accept 7",
    );
    expect(contradictionRejectCommand("gbrain", "7")).toBe(
      "gbrain decide proposals reject 7",
    );
  });
  test("reject bad refs/ids before a string is ever rendered", () => {
    expect(() => trustConfirmCommand(bin, "tp;rm -rf")).toThrow();
    expect(() => trustDropCommand(bin, "xp1")).toThrow(); // bad prefix
    expect(() => edgeAcceptCommand(bin, "12a")).toThrow();
    expect(() => contradictionAcceptCommand(bin, "dp7")).toThrow(); // bare digits, not the trust-ref shape
    expect(() => contradictionRejectCommand(bin, "-1")).toThrow();
  });
  test("reject bad bins — argv[0] and paste-text share one charset", () => {
    expect(() => trustConfirmCommand("my gbrain", "tp1")).toThrow();
    expect(() => trustDropCommand("./gbrain", "tp1")).toThrow();
    expect(() => trustExplainCommand("gbrain$(x)", "tp1")).toThrow();
  });
});

describe("buildGraphKey", () => {
  test("qualifies by source when known, stays bare otherwise", () => {
    expect(buildGraphKey("main", "kb/migration0007")).toBe(
      "main/kb/migration0007",
    );
    expect(buildGraphKey(undefined, "some/slug")).toBe("some/slug");
    expect(buildGraphKey("main", "plain-slug")).toBe("main/plain-slug");
  });
});

describe("authRevokeClientCommand", () => {
  const clientId =
    "gbrain_cl_489f6ae02796baf04d3bbb080308b39ec98d8991e1cc9597ed00b8ece4c2c7c9";

  test("builds the pinned positional form (probed 0.60.558)", () => {
    expect(authRevokeClientCommand("gbrain", clientId)).toBe(
      `gbrain auth revoke-client ${clientId}`,
    );
  });

  test("refuses bad bins and client ids — never pastes a guess", () => {
    expect(() => authRevokeClientCommand("gbrain;rm", clientId)).toThrow();
    expect(() => authRevokeClientCommand("gbrain", "cl_abc")).toThrow();
    expect(() => authRevokeClientCommand("gbrain", "../../etc")).toThrow();
  });
});

describe("authClientsListCommand", () => {
  test("human view, no --json (readable table for the paste)", () => {
    expect(authClientsListCommand("gbrain")).toBe("gbrain auth clients");
    expect(authClientsListCommand("/opt/gbrain")).toBe("/opt/gbrain auth clients");
    expect(() => authClientsListCommand("gbrain x")).toThrow();
  });
});

// --- 0.5.0: doctor check rows + dream calibration command -----------------------

describe("normalizeDoctorCheck (three-state vocabulary)", () => {
  test("ok/warn/fail pass through; unknown status reads na", () => {
    expect(normalizeDoctorCheck({ name: "a", status: "ok" })?.status).toBe("ok");
    expect(normalizeDoctorCheck({ name: "a", status: "warn" })?.status).toBe("warn");
    expect(normalizeDoctorCheck({ name: "a", status: "fail" })?.status).toBe("fail");
    expect(normalizeDoctorCheck({ name: "a", status: "weird" })?.status).toBe("na");
    expect(normalizeDoctorCheck({ name: "a" })?.status).toBe("na");
  });

  test("readiness_state not_applicable wins over status ok (probed shape)", () => {
    const row = normalizeDoctorCheck({
      name: "cron_gbrain_home",
      status: "ok",
      readiness_state: "not_applicable",
      severity: "info",
      message: "No finding: this check does not apply to this brain right now.",
    });
    expect(row?.status).toBe("na");
    expect(row?.message).toContain("does not apply");
    expect((row as Record<string, unknown>).severity).toBe("info");
  });

  test("fix payload passes through; nameless rows are dropped", () => {
    const row = normalizeDoctorCheck({
      name: "cycle_freshness",
      status: "warn",
      fix: { command: "gbrain dream --source default --brain host", consent: ["paid"] },
    });
    expect(row?.fix?.command).toContain("dream");
    expect(row?.fix?.consent).toEqual(["paid"]);
    expect(normalizeDoctorCheck({ status: "ok" })).toBeNull();
    expect(normalizeDoctorCheck({ name: "", status: "ok" })).toBeNull();
  });
});

describe("dreamCalibrationCommand (0.5.0 1.3)", () => {
  test("plain form: bin + source + both phases, canonical order", () => {
    expect(dreamCalibrationCommand("gbrain", "default")).toBe(
      "gbrain dream --source default --phase propose_takes --phase grade_takes",
    );
  });

  test("direct-call form on wrapper brains: GBRAIN_HOME prefix + the REAL bin", () => {
    expect(
      dreamCalibrationCommand("gbrain-bip", "yon-bip", {
        gbrainBin: "/home/dev/.bun/bin/gbrain",
        gbrainHome: "/home/dev/gbrain-bip",
      }),
    ).toBe(
      "GBRAIN_HOME=/home/dev/gbrain-bip /home/dev/.bun/bin/gbrain dream --source yon-bip --phase propose_takes --phase grade_takes",
    );
  });

  test("refuses upstream-illegal source ids and metachar paths — never pastes a guess", () => {
    expect(() => dreamCalibrationCommand("gbrain", "Bad_Source")).toThrow();
    expect(() => dreamCalibrationCommand("gbrain", "a;rm")).toThrow();
    expect(() =>
      dreamCalibrationCommand("gbrain", "default", {
        gbrainBin: "/bin/gbrain",
        gbrainHome: "/home/oops; rm",
      }),
    ).toThrow();
    // a lone gbrainBin without a valid home falls back to the plain bin —
    // never a half-built direct call
    expect(
      dreamCalibrationCommand("gbrain", "default", { gbrainBin: "/bin/gbrain" }),
    ).toBe("gbrain dream --source default --phase propose_takes --phase grade_takes");
  });
});
