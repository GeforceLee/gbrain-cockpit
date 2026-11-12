import { describe, expect, test } from "bun:test";
import {
  createInboxStateStore,
  resolveInboxStatePath,
} from "./inbox-state";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { homedir } from "node:os";

// 0.5.2 (owner D2 option A): cockpit-own relief state. The path rules are
// deployment safety: never the cwd (systemd WorkingDirectory IS the release
// dir — a state file there dies on redeploy).

describe("resolveInboxStatePath (deployment-safe derivation)", () => {
  test("explicit env wins", () => {
    expect(resolveInboxStatePath({ file: "/etc/cockpit/state.json" })).toBe(
      "/etc/cockpit/state.json",
    );
  });

  test("else alongside the profiles file (outside release dirs on managed hosts)", () => {
    expect(
      resolveInboxStatePath({ profilesFile: "/home/dev/cockpit/brains.json" }),
    ).toBe("/home/dev/cockpit/inbox-state.json");
  });

  test("else ~/.cockpit/ — never the cwd", () => {
    const p = resolveInboxStatePath({});
    expect(p).toBe(join(homedir(), ".cockpit", "inbox-state.json"));
  });
});

describe("InboxStateStore (read/mutate/atomic write/fail-visible)", () => {
  function temp() {
    const dir = mkdtempSync(join(tmpdir(), "cockpit-state-test-"));
    return { dir, file: join(dir, "inbox-state.json") };
  }

  test("absent file = empty state (normal first run); mutate roundtrips per profile", async () => {
    const { dir, file } = temp();
    try {
      const store = createInboxStateStore({ file, now: () => "2026-11-12T00:00:00Z" });
      const first = await store.read("atlas");
      expect(first.state).toEqual({ muted: [], snoozed: [] });
      expect(first.error).toBeUndefined();

      await store.mutate("atlas", (s) => {
        s.muted.push({ source: "docs", at: store.now() });
        s.snoozed.push({ id: 7, source: "docs", snoozedAt: store.now() });
      });
      const raw = JSON.parse(readFileSync(file, "utf8"));
      expect(raw.profiles.atlas.muted).toEqual([{ source: "docs", at: "2026-11-12T00:00:00Z" }]);
      expect(raw.version).toBe(1);

      // profile isolation at the file level
      const other = await store.read("bip");
      expect(other.state.muted).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("corrupt file: reads fail-visible, mutations refuse, file untouched", async () => {
    const { dir, file } = temp();
    try {
      writeFileSync(file, "{ broken", "utf8");
      const store = createInboxStateStore({ file });
      const snap = await store.read("atlas");
      expect(snap.error).toContain("unreadable");
      expect(snap.state).toEqual({ muted: [], snoozed: [] });
      await expect(
        store.mutate("atlas", (s) => s.muted.push({ source: "x", at: "y" })),
      ).rejects.toThrow(/unreadable/);
      expect(readFileSync(file, "utf8")).toBe("{ broken"); // never overwritten
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
