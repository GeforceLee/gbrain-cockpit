import type { ProfileInfo, ProfilesResponse } from "@gbrain-cockpit/shared";
import { ConfigError } from "./config";
import { CliDriver, locateGbrainBin } from "./drivers/cli";
import { McpDriver } from "./drivers/mcp";
import { PgReadonlyDriver } from "./drivers/pg-readonly";
import type { ProfilesConfig, ResolvedProfile } from "./profiles";

// BrainRegistry (ARCHITECTURE §8, multi-brain switching): eagerly validates
// every profile's CLI resolution at startup (fail-closed where a secret or
// an explicit setting is wrong), then lazily builds one driver set per
// profile on first use. Driver instances are NEVER shared across profiles:
// McpDriver holds a session id and a TTL cache, PgReadonlyDriver a graph
// snapshot — per-profile construction is what keeps two brains' data from
// ever meeting inside one cache.

/** The per-request API context: one brain's three channels. */
export interface BrainChannels {
  readonly id: string;
  readonly profile: ResolvedProfile;
  readonly mcp: McpDriver;
  readonly cli: CliDriver | null;
  readonly pg: PgReadonlyDriver;
  /** absolute CLI path as resolved at startup (null = unavailable) */
  readonly cliBinResolved: string | null;
  /** why the CLI channel is unavailable, when it is (display in health) */
  readonly cliNote?: string;
}

export interface RegistryDeps {
  which?: (name: string) => Promise<string | null>;
  accessX?: (path: string) => Promise<boolean>;
  /** injectable for tests — every profile's McpDriver uses it */
  fetchFn?: typeof fetch;
}

const PROFILE_INFO_TTL_MS = 60_000;

export class BrainRegistry {
  readonly #profiles = new Map<string, ResolvedProfile>();
  readonly #deps: RegistryDeps;
  readonly #cli: ReadonlyMap<string, { bin: string | null; note?: string }>;
  readonly #channels = new Map<string, BrainChannels>();
  readonly #profileInfo = new Map<
    string,
    { at: number; value: ProfileInfo }
  >();
  #whichGbrainMemo: string | null | undefined;

  readonly defaultId: string;
  readonly mode: ProfilesConfig["mode"];

  private constructor(
    config: ProfilesConfig,
    cli: ReadonlyMap<string, { bin: string | null; note?: string }>,
    deps: RegistryDeps,
  ) {
    for (const p of config.profiles) this.#profiles.set(p.id, p);
    this.defaultId = config.defaultId;
    this.mode = config.mode;
    this.#cli = cli;
    this.#deps = deps;
  }

  /** Eager startup validation — see the class comment for fail-closed rules. */
  static async create(
    config: ProfilesConfig,
    deps: RegistryDeps = {},
  ): Promise<BrainRegistry> {
    const resolution = new Map<string, { bin: string | null; note?: string }>();
    for (const p of config.profiles) {
      if (p.cliBin) {
        const bin = await locateGbrainBin(p.cliBin, deps);
        if (!bin) {
          if (config.mode === "legacy-env") {
            // 0.1.1 semantics preserved exactly: an explicitly-set-but-broken
            // GBRAIN_BIN was fatal; an implicit discovery miss never was.
            throw new ConfigError(
              `GBRAIN_BIN is set but not executable: ${p.cliBin}`,
              "fix the path or clear GBRAIN_BIN to auto-discover gbrain on PATH.",
            );
          }
          console.warn(
            `[brains] profile ${p.id}: cliBin "${p.cliBin}" not resolvable — CLI channel degrades to copy-command for THIS profile only`,
          );
          resolution.set(p.id, {
            bin: null,
            note: `configured cliBin "${p.cliBin}" not found (not on PATH / not executable)`,
          });
          continue;
        }
        resolution.set(p.id, { bin });
      } else {
        const bin = await this.#discoverGbrain(deps);
        resolution.set(p.id, { bin });
      }
    }
    return new BrainRegistry(config, resolution, deps);
  }

  static async #discoverGbrain(deps: RegistryDeps): Promise<string | null> {
    // Every profile without an explicit cliBin shares one PATH discovery.
    return locateGbrainBin(null, deps);
  }

  /** The channels for a profile id; null id means the default profile. Unknown → null. */
  resolve(id: string | null | undefined): BrainChannels | null {
    const key = id?.trim() || this.defaultId;
    const profile = this.#profiles.get(key);
    if (!profile) return null;
    let ch = this.#channels.get(key);
    if (!ch) {
      const bin = this.#cli.get(key)?.bin ?? null;
      ch = {
        id: profile.id,
        profile,
        mcp: new McpDriver({
          url: profile.mcpUrl,
          token: profile.mcpToken ?? "",
          ...(profile.oauth ? { oauth: profile.oauth } : {}),
          ...(this.#deps.fetchFn ? { fetchFn: this.#deps.fetchFn } : {}),
        }),
        cli: bin ? new CliDriver(bin) : null,
        pg: new PgReadonlyDriver({ dsn: profile.pgReadonlyDsn ?? null }),
        cliBinResolved: bin,
        ...(this.#cli.get(key)?.note ? { cliNote: this.#cli.get(key)!.note } : {}),
      };
      this.#channels.set(key, ch);
    }
    return ch;
  }

  get profileCount(): number {
    return this.#profiles.size;
  }

  /**
   * The wire list for GET /api/profiles — ids, labels, CLI command name and
   * a whoami-derived readOnly hint. Never any secret. readOnly is undefined
   * when whoami can't be reached: unknown is not "read-only".
   */
  async profileInfos(): Promise<ProfilesResponse> {
    const profiles: ProfileInfo[] = [];
    for (const p of this.#profiles.values()) {
      profiles.push(await this.#deriveProfileInfo(p));
    }
    return { defaultId: this.defaultId, profiles };
  }

  async #deriveProfileInfo(p: ResolvedProfile): Promise<ProfileInfo> {
    const cached = this.#profileInfo.get(p.id);
    if (cached && Date.now() - cached.at < PROFILE_INFO_TTL_MS) {
      return cached.value;
    }
    const info: ProfileInfo = {
      id: p.id,
      name: p.name,
      cliCommand: p.cliBin ?? "gbrain",
    };
    try {
      const ch = this.resolve(p.id);
      // Short budget: /api/profiles must not hang on a dead profile.
      const whoami = await ch!.mcp.whoami({ timeoutMs: 4_000 });
      if (Array.isArray(whoami.scopes)) {
        const scopes = whoami.scopes.filter(
          (s): s is string => typeof s === "string",
        );
        info.readOnly = !scopes.includes("write");
        info.canConfirm = scopes.includes("memory_confirm");
      }
    } catch {
      // MCP unreachable — leave readOnly unset rather than guessing.
    }
    this.#profileInfo.set(p.id, { at: Date.now(), value: info });
    return info;
  }

  /** Drop the derived profile infos (e.g. after a credential rescope). */
  invalidateProfileInfos(): void {
    this.#profileInfo.clear();
  }
}
