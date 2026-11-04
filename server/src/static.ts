import { stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

// Static serving of the built web app (ARCHITECTURE §5-12): every request
// path is resolved against the dist root and must stay inside it — `..`,
// encoded variants, NUL bytes, and absolute forms are rejected before any
// filesystem call. Assets get immutable caching (content-hashed names),
// index.html always revalidates.

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
  ".webmanifest": "application/manifest+json",
};

// A Response body can be consumed exactly once — a shared 404 instance
// throws ERR_BODY_ALREADY_USED on its second send (found live: /favicon.ico
// does not exist in dist, so every page load re-requested the same object
// until the second one killed the request). Always mint a fresh Response.
const notFound = (): Response => new Response("not found", { status: 404 });

/** Resolve a request path to a file inside distRoot, or null if unsafe/absent. */
export function resolveStaticPath(
  distRoot: string,
  pathname: string,
): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes("\0") || decoded.includes("..")) return null;

  const rel = decoded.replace(/^\/+/, "");
  // Belt to the suspenders: canonical resolution must remain inside root.
  const target = resolve(distRoot, rel);
  if (target !== distRoot && !target.startsWith(distRoot + sep)) return null;

  const file = rel === "" ? join(distRoot, "index.html") : target;
  const ext = file.slice(file.lastIndexOf("."));
  if (!MIME[ext]) return null; // only known asset types are served
  return file;
}

export async function serveStatic(
  distRoot: string,
  pathname: string,
): Promise<Response> {
  const file = resolveStaticPath(distRoot, pathname);
  if (!file) return notFound();

  let size: number;
  try {
    const info = await stat(file);
    if (!info.isFile()) return notFound();
    size = info.size;
  } catch {
    return notFound();
  }

  const ext = file.slice(file.lastIndexOf("."));
  const data = new Uint8Array(await Bun.file(file).arrayBuffer());
  const isHtml = ext === ".html";
  return new Response(data, {
    status: 200,
    headers: {
      "content-type": MIME[ext]!,
      "content-length": String(size),
      "cache-control": isHtml
        ? "no-cache"
        // vite hashes asset filenames, so their content address never changes
        : "public, max-age=31536000, immutable",
    },
  });
}
