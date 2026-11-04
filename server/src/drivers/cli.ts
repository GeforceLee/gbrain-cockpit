import { execFile } from "node:child_process";
import { access, constants } from "node:fs/promises";
import { promisify } from "node:util";
import type { CliCheck } from "@gbrain-cockpit/shared";
import type { Config } from "../config";

// M0 CLI channel inspection: presence only. A gbrain binary found on THIS
// host is not yet an adjudication channel — exec must happen on the brain
// host (ENVIRONMENT §5; on a dev Mac the local binary talks to a different or
// no brain). The V1.0 CLI driver adds the whitelist exec discipline plus the
// warm/cold smoke test and a same-brain identity check; until then a found
// binary reports "unverified" and the UI stays in copy-command mode.

const execFileP = promisify(execFile);

export async function locateGbrainBin(explicit?: string | null): Promise<string | null> {
  if (explicit) {
    try {
      await access(explicit, constants.X_OK);
      return explicit;
    } catch {
      return null;
    }
  }
  try {
    const { stdout } = await execFileP("which", ["gbrain"]);
    const first = stdout.trim().split("\n")[0];
    return first ? first : null;
  } catch {
    return null;
  }
}

export async function inspectCli(cfg: Pick<Config, "gbrainBin">): Promise<CliCheck> {
  const bin = await locateGbrainBin(cfg.gbrainBin);
  if (!bin) {
    return { status: "down", bin: null, reason: "binary-not-found" };
  }
  return { status: "degraded", bin, reason: "binary-found-unverified" };
}
