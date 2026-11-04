import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadRootEnv } from "./env";

// loadRootEnv is path-injected so the test doesn't touch the real repo .env.

const KEY_PREFIX = "COCKPIT_TEST_ENV_";
const fixtureKeys: string[] = [];

function writeFixture(content: string): string {
  const path = join(
    tmpdir(),
    `cockpit-env-test-${crypto.randomUUID()}.env`,
  );
  fixtureKeys.push(
    ...[...content.matchAll(new RegExp(`${KEY_PREFIX}[A-Z_]+`, "g"))].map(
      (m) => m[0],
    ),
  );
  Bun.write(path, content);
  return path;
}

afterEach(async () => {
  for (const key of fixtureKeys.splice(0)) delete process.env[key];
});

describe("loadRootEnv", () => {
  test("parses KEY=VALUE lines, quotes, and skips comments", async () => {
    const path = await writeFixture(
      [
        "# comment line",
        `${KEY_PREFIX}PLAIN=hello`,
        `${KEY_PREFIX}QUOTED="with spaces"`,
        `${KEY_PREFIX}SINGLE='single'`,
        `${KEY_PREFIX}EMPTY=`,
        `export ${KEY_PREFIX}EXPORTED=yes`,
        "not-an-assignment",
        "",
      ].join("\n"),
    );
    loadRootEnv(path);
    expect(process.env[`${KEY_PREFIX}PLAIN`]).toBe("hello");
    expect(process.env[`${KEY_PREFIX}QUOTED`]).toBe("with spaces");
    expect(process.env[`${KEY_PREFIX}SINGLE`]).toBe("single");
    expect(process.env[`${KEY_PREFIX}EMPTY`]).toBe("");
    expect(process.env[`${KEY_PREFIX}EXPORTED`]).toBe("yes");
    await rm(path, { force: true });
  });

  test("never overrides variables already set in the real environment", async () => {
    process.env[`${KEY_PREFIX}PLAIN`] = "from-real-env";
    const path = await writeFixture(`${KEY_PREFIX}PLAIN=from-file\n`);
    loadRootEnv(path);
    expect(process.env[`${KEY_PREFIX}PLAIN`]).toBe("from-real-env");
    await rm(path, { force: true });
  });

  test("missing file is a no-op", () => {
    expect(() =>
      loadRootEnv(join(tmpdir(), "cockpit-definitely-missing.env")),
    ).not.toThrow();
  });
});
