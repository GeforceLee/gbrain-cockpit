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

describe("0.7 config: the token registry path and the origin list", () => {
  test("COCKPIT_TOKENS_FILE unset = the feature is off", () => {
    expect(loadConfig(BASE).tokensFile).toBeNull();
    expect(loadConfig(BASE).allowedOrigins).toEqual([]);
  });

  test("COCKPIT_TOKENS_FILE must be an absolute path", () => {
    expect(loadConfig({ ...BASE, COCKPIT_TOKENS_FILE: "/home/me/cockpit/tokens.json" }).tokensFile).toBe(
      "/home/me/cockpit/tokens.json",
    );
    try {
      loadConfig({ ...BASE, COCKPIT_TOKENS_FILE: "tokens.json" });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).message).toContain("absolute");
    }
  });

  test("origins: canonical entries, deduplicated; http only for loopback", () => {
    expect(
      loadConfig({
        ...BASE,
        COCKPIT_ALLOWED_ORIGINS:
          " https://cockpit.example.com , https://a.example.com:8443,,https://cockpit.example.com ",
      }).allowedOrigins,
    ).toEqual(["https://cockpit.example.com", "https://a.example.com:8443"]);
    expect(loadConfig({ ...BASE, COCKPIT_ALLOWED_ORIGINS: "http://127.0.0.1:8787" }).allowedOrigins).toEqual([
      "http://127.0.0.1:8787",
    ]);
    expect(loadConfig({ ...BASE, COCKPIT_ALLOWED_ORIGINS: "http://[::1]:8787" }).allowedOrigins).toEqual([
      "http://[::1]:8787",
    ]);
  });

  test("origins: anything that is not an exact canonical https origin fails the boot", () => {
    for (const bad of [
      "cockpit.example.com", // no scheme
      "http://cockpit.example.com", // plain http off-loopback
      "https://cockpit.example.com/", // trailing slash
      "https://Cockpit.example.com", // case
      "https://cockpit.example.com:443", // default port
      "https://cockpit.example.com/cockpit", // a path
      "https://cockpit.example.com?q=1", // a query
      "https://user:pw@cockpit.example.com", // account information
      "https://*", // wildcard-shaped: the check is exact-match, so it must not slip through
      "ftp://cockpit.example.com",
      "not a url",
    ]) {
      try {
        loadConfig({ ...BASE, COCKPIT_ALLOWED_ORIGINS: bad });
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(ConfigError);
      }
    }
  });

  test("the hint for a non-canonical entry prints the canonical spelling", () => {
    try {
      loadConfig({ ...BASE, COCKPIT_ALLOWED_ORIGINS: "https://Cockpit.example.com/" });
      expect.unreachable();
    } catch (err) {
      expect((err as ConfigError).hint).toContain("https://cockpit.example.com");
    }
  });
});
