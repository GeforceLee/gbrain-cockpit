import { describe, expect, test } from "bun:test";
import {
  ADJUDICATION_CHANNELS,
  ERROR_CODES,
  OWNER_BIN_RE,
  PROFILE_ID_RE,
  SOURCE_ID_RE,
  buildGraphKey,
  edgeAcceptCommand,
  isValidSourceId,
  takesAcceptCommand,
  trustConfirmCommand,
  trustDropCommand,
  trustExplainCommand,
  trustReleaseCommand,
  worstStatus,
  type AdjudicationAction,
  type Channel,
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
    expect(takesAcceptCommand(bin, "99")).toBe(
      "gbrain-bip takes propose --accept 99",
    );
  });
  test("reject bad refs/ids before a string is ever rendered", () => {
    expect(() => trustConfirmCommand(bin, "tp;rm -rf")).toThrow();
    expect(() => trustDropCommand(bin, "xp1")).toThrow(); // bad prefix
    expect(() => edgeAcceptCommand(bin, "12a")).toThrow();
    expect(() => takesAcceptCommand(bin, "-1")).toThrow();
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
