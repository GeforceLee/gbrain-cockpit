import { describe, expect, test } from "bun:test";
import { loadConfig, ConfigError } from "./config";

// cockpit's own process config only — brain connection profiles (and their
// fail-closed tests) live in profiles.test.ts.

const BASE = { COCKPIT_TOKEN: "tok" };

describe("loadConfig (cockpit process config)", () => {
  test("COCKPIT_TOKEN missing fails closed with a ready-to-use secret", () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
    try {
      loadConfig({});
      expect.unreachable();
    } catch (err) {
      const hint = (err as ConfigError).hint;
      expect(hint).toContain("COCKPIT_TOKEN=");
    }
  });

  test("blank token is also missing (trim)", () => {
    expect(() => loadConfig({ COCKPIT_TOKEN: "   " })).toThrow(ConfigError);
  });

  test("defaults bind and port", () => {
    const cfg = loadConfig(BASE);
    expect(cfg.bind).toBe("127.0.0.1");
    expect(cfg.port).toBe(8787);
    expect(cfg.cockpitToken).toBe("tok");
  });

  test("explicit bind and port win", () => {
    const cfg = loadConfig({
      ...BASE,
      COCKPIT_BIND: "0.0.0.0",
      COCKPIT_PORT: "8799",
    });
    expect(cfg.bind).toBe("0.0.0.0");
    expect(cfg.port).toBe(8799);
  });

  test("invalid port fails closed", () => {
    expect(() => loadConfig({ ...BASE, COCKPIT_PORT: "0" })).toThrow(ConfigError);
    expect(() =>
      loadConfig({ ...BASE, COCKPIT_PORT: "70000" }),
    ).toThrow(ConfigError);
    expect(() =>
      loadConfig({ ...BASE, COCKPIT_PORT: "http" }),
    ).toThrow(ConfigError);
  });

  test("COCKPIT_ADMIN_TOKEN unset stays null (single-token installs unchanged)", () => {
    expect(loadConfig(BASE).adminToken).toBeNull();
  });

  test("COCKPIT_ADMIN_TOKEN set is carried as the management tier", () => {
    const cfg = loadConfig({ ...BASE, COCKPIT_ADMIN_TOKEN: "adm" });
    expect(cfg.adminToken).toBe("adm");
  });

  test("an admin token equal to the base token is a config error", () => {
    expect(() =>
      loadConfig({ ...BASE, COCKPIT_ADMIN_TOKEN: "tok" }),
    ).toThrow(ConfigError);
    // whitespace-trimmed equality counts too
    expect(() =>
      loadConfig({ ...BASE, COCKPIT_ADMIN_TOKEN: " tok " }),
    ).toThrow(ConfigError);
  });
});
