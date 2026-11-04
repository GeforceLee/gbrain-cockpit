import { describe, expect, test } from "bun:test";
import {
  ADJUDICATION_CHANNELS,
  ERROR_CODES,
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
