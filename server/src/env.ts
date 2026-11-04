import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Bun auto-loads .env from the process cwd — which is the repo root only when
// the server happens to be started from there (workspace filter runs and
// in-package `bun run start` both land elsewhere). Resolve the repo-root .env
// from THIS MODULE's location instead of the cwd, and never override vars
// that are already set in the real environment (real env wins over files).
//
// Deliberately minimal: KEY=VALUE lines, optional matching quotes, '#' line
// comments, `export ` prefix tolerated. No inline comments, no interpolation.

export function loadRootEnv(
  envPath = fileURLToPath(new URL("../../.env", import.meta.url)),
): void {
  if (!existsSync(envPath)) return;

  for (const rawLine of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim().replace(/^export\s+/, "");
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
