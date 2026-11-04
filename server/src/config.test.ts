import { describe, expect, test } from "bun:test";
import { ConfigError, loadConfig } from "./config";

const BASE_ENV = {
  COCKPIT_TOKEN: "cockpit-secret",
  GBRAIN_MCP_TOKEN: "gbrain-secret",
};

describe("loadConfig (fail-closed secrets)", () => {
  test("missing COCKPIT_TOKEN refuses to start and suggests a generated token", () => {
    try {
      loadConfig({ ...BASE_ENV, COCKPIT_TOKEN: undefined });
      throw new Error("expected ConfigError");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      const e = err as ConfigError;
      expect(e.message).toContain("COCKPIT_TOKEN");
      expect(e.hint).toContain("COCKPIT_TOKEN=");
    }
  });

  test("empty/whitespace COCKPIT_TOKEN counts as missing", () => {
    expect(() => loadConfig({ ...BASE_ENV, COCKPIT_TOKEN: "   " })).toThrow(
      ConfigError,
    );
  });

  test("missing GBRAIN_MCP_TOKEN refuses to start and suggests the mint command", () => {
    try {
      loadConfig({ ...BASE_ENV, GBRAIN_MCP_TOKEN: undefined });
      throw new Error("expected ConfigError");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      const e = err as ConfigError;
      expect(e.hint).toContain("gbrain auth create");
      // The takes-holders trap must be surfaced at startup, not discovered
      // later as mysteriously empty queues (ARCHITECTURE §3.1).
      expect(e.hint).toContain("takes-holders");
    }
  });

  test("applies documented defaults", () => {
    const cfg = loadConfig({ ...BASE_ENV });
    expect(cfg.bind).toBe("127.0.0.1");
    expect(cfg.port).toBe(8787);
    expect(cfg.gbrainMcpUrl).toBe("http://127.0.0.1:3131/mcp");
    expect(cfg.gbrainTakesHolders).toBeNull();
    expect(cfg.gbrainBin).toBeNull();
    expect(cfg.pgReadonlyDsn).toBeNull();
  });

  test("parses and validates overrides", () => {
    const cfg = loadConfig({
      ...BASE_ENV,
      COCKPIT_BIND: "0.0.0.0",
      COCKPIT_PORT: "9000",
      GBRAIN_MCP_URL: "http://10.0.0.1:3131/mcp",
      GBRAIN_TAKES_HOLDERS: "world, brain,",
      GBRAIN_BIN: "/usr/local/bin/gbrain",
    });
    expect(cfg.bind).toBe("0.0.0.0");
    expect(cfg.port).toBe(9000);
    expect(cfg.gbrainMcpUrl).toBe("http://10.0.0.1:3131/mcp");
    expect(cfg.gbrainTakesHolders).toEqual(["world", "brain"]);
    expect(cfg.gbrainBin).toBe("/usr/local/bin/gbrain");
  });

  test.each(["0", "70000", "not-a-port", ""])(
    "rejects invalid COCKPIT_PORT %j",
    (raw) => {
      expect(() =>
        loadConfig({ ...BASE_ENV, COCKPIT_PORT: raw }),
      ).toThrow(ConfigError);
    },
  );
});
