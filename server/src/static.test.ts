import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveStaticPath, serveStatic } from "./static";

// Path-traversal payloads from ARCHITECTURE §5-12 must never touch the
// filesystem outside dist root — these cases mirror the CI gate.

let distRoot = "";

async function makeDist(): Promise<void> {
  distRoot = join(tmpdir(), `cockpit-static-${crypto.randomUUID()}`);
  await mkdir(join(distRoot, "assets"), { recursive: true });
  await writeFile(join(distRoot, "index.html"), "<html>cockpit</html>");
  await writeFile(join(distRoot, "assets", "app-abc123.js"), "console.log(1)");
  await writeFile(join(distRoot, "secret.txt"), "top secret");
}

afterEach(async () => {
  if (distRoot) await rm(distRoot, { recursive: true, force: true });
});

describe("resolveStaticPath", () => {
  test("resolves root, index, and hashed assets", async () => {
    await makeDist();
    expect(resolveStaticPath(distRoot, "/")).toBe(join(distRoot, "index.html"));
    expect(resolveStaticPath(distRoot, "/index.html")).toBe(
      join(distRoot, "index.html"),
    );
    expect(resolveStaticPath(distRoot, "/assets/app-abc123.js")).toBe(
      join(distRoot, "assets", "app-abc123.js"),
    );
  });

  test("rejects traversal and encoded variants", async () => {
    await makeDist();
    const payloads = [
      "/../.env",
      "/..%2F..%2F.env",
      "/%2e%2e/secret.txt",
      "/a/../../secret.txt",
      "/..\\secret.txt",
      "/%00secret.txt",
      "//etc/passwd",
    ];
    for (const p of payloads) {
      expect(resolveStaticPath(distRoot, p)).toBeNull();
    }
  });

  test("rejects extensions outside the served set", async () => {
    await makeDist();
    expect(resolveStaticPath(distRoot, "/secret.txt")).toBeNull();
  });
});

describe("serveStatic", () => {
  test("serves index.html with no-cache", async () => {
    await makeDist();
    const res = await serveStatic(distRoot, "/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("cache-control")).toBe("no-cache");
    expect(await res.text()).toContain("cockpit");
  });

  test("serves assets with immutable caching", async () => {
    await makeDist();
    const res = await serveStatic(distRoot, "/assets/app-abc123.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("immutable");
  });

  test("404s traversal payloads without reading them", async () => {
    await makeDist();
    const res = await serveStatic(distRoot, "/../.env");
    expect(res.status).toBe(404);
    const missing = await serveStatic(distRoot, "/nope.js");
    expect(missing.status).toBe(404);
  });

  // regression: /favicon.ico does not exist in dist, so browsers re-request
  // the 404 — a shared Response object throws ERR_BODY_ALREADY_USED on its
  // second send (found live when the demo server died on page reload)
  test("every 404 is a fresh, readable Response", async () => {
    await makeDist();
    const first = await serveStatic(distRoot, "/favicon.ico");
    const second = await serveStatic(distRoot, "/favicon.ico");
    const third = await serveStatic(distRoot, "/favicon.ico");
    expect(first.status).toBe(404);
    expect(second.status).toBe(404);
    expect(third.status).toBe(404);
    expect(await first.text()).toBe("not found");
    expect(await second.text()).toBe("not found");
    expect(await third.text()).toBe("not found");
  });
});
