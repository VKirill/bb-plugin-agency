import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Installed BB plugins as the Agency sees them. Read from the BB server
 * (`bb.sdk.plugins.list()`): no model and no tokens. The list is cached for a
 * short time so domain rules can ask synchronously.
 */

export type InstalledPluginView = {
  id: string;
  name: string;
  description: string | null;
  version: string;
  running: boolean;
  /** Names of the agent tools the plugin contributes (`env_get`, `bb_file_gateway`). */
  toolNames: string[];
  /** The plugin ships at least one skill. */
  hasSkill: boolean;
  /** The plugin adds a section to thread instructions, the system message of a session. */
  hasInstructions: boolean;
  /** `bb <name>` command, when the plugin has one. */
  cliCommand: string | null;
};

type ListedPlugin = {
  id: string;
  rootDir?: string | null;
  name?: string | null;
  description?: string | null;
  version?: string | null;
  status?: string | null;
  enabled?: boolean | null;
  capabilities?: readonly { kind: string; id: string }[] | null;
  cliCommand?: { name: string } | null;
};

export type PluginDirectory = {
  list(): Promise<InstalledPluginView[]>;
  /** Last successful read; null before the first one. */
  cached(): InstalledPluginView[] | null;
  running(pluginId: string): Promise<boolean>;
  /** Synchronous check on the last read: false when nothing was read yet. */
  runningCached(pluginId: string): boolean;
};

/** Plugins whose presence opens Agency features. */
export const PROJECT_FOLDERS_PLUGIN_ID = "project-folders";
export const FILE_GATEWAY_PLUGIN_ID = "file-gateway";

/**
 * The Agency itself and model providers are not offered as employee plugins, nor are
 * plugins that only change the BB interface (file viewers, themes): no tools, no skill,
 * no instructions — an employee gets nothing from them.
 */
export function isEmployeePluginCandidate(plugin: InstalledPluginView, selfId = "agency"): boolean {
  if (plugin.id === selfId || plugin.id.startsWith("provider-")) return false;
  return plugin.toolNames.length > 0 || plugin.hasSkill || plugin.hasInstructions;
}

const INSTRUCTION_WINDOW = 1500;

/**
 * Whether a server bundle adds thread instructions. BB does not report it, so the built
 * code is read: `agents.contributeInstructions(` always does; `agents.configure(` does
 * when its callback returns `instructions`.
 */
export function bundleAddsInstructions(source: string): boolean {
  if (source.includes("contributeInstructions(")) return true;
  for (let index = source.indexOf("agents.configure("); index >= 0; index = source.indexOf("agents.configure(", index + 1)) {
    if (source.slice(index, index + INSTRUCTION_WINDOW).includes("instructions")) return true;
  }
  return false;
}

/** Server bundles of a plugin folder: `dist/server*.js` or a root `server*.js`. Cached by path and change time. */
export function createInstructionDetector() {
  const cache = new Map<string, { stamp: string; value: boolean }>();
  return (rootDir: string | null | undefined): boolean => {
    if (!rootDir) return false;
    const files: string[] = [];
    for (const dir of [join(rootDir, "dist"), rootDir]) {
      try {
        for (const name of readdirSync(dir)) if (/^server.*\.(m?js)$/.test(name)) files.push(join(dir, name));
      } catch {
        // No such folder: nothing to read there.
      }
    }
    if (!files.length) return false;
    try {
      const stamp = files.map((file) => `${file}:${statSync(file).mtimeMs}`).join("|");
      const hit = cache.get(rootDir);
      if (hit?.stamp === stamp) return hit.value;
      const value = files.some((file) => bundleAddsInstructions(readFileSync(file, "utf8")));
      cache.set(rootDir, { stamp, value });
      return value;
    } catch {
      return false;
    }
  };
}

export function toPluginView(plugin: ListedPlugin, addsInstructions: (rootDir: string | null | undefined) => boolean = () => false): InstalledPluginView {
  const capabilities = plugin.capabilities ?? [];
  return {
    id: plugin.id,
    name: plugin.name?.trim() || plugin.id,
    description: plugin.description?.trim() || null,
    version: plugin.version ?? "",
    running: plugin.status === "running" && plugin.enabled !== false,
    toolNames: [...new Set(capabilities.filter((item) => item.kind === "agent-tool").map((item) => item.id))].sort(),
    hasSkill: capabilities.some((item) => item.kind === "skill"),
    hasInstructions: addsInstructions(plugin.rootDir),
    cliCommand: plugin.cliCommand?.name ?? null,
  };
}

export function createPluginDirectory(deps: {
  listPlugins: () => Promise<{ plugins: readonly ListedPlugin[] }>;
  /** Reads a plugin folder for thread instructions; omitted in tests. */
  addsInstructions?: (rootDir: string | null | undefined) => boolean;
  now?: () => number;
  ttlMs?: number;
}): PluginDirectory {
  const now = deps.now ?? (() => Date.now());
  const ttlMs = deps.ttlMs ?? 30_000;
  let last: { at: number; plugins: InstalledPluginView[] } | null = null;
  let pending: Promise<InstalledPluginView[]> | null = null;

  const read = async (): Promise<InstalledPluginView[]> => {
    if (last && now() - last.at < ttlMs) return last.plugins;
    if (pending) return pending;
    pending = deps
      .listPlugins()
      .then((listed) => {
        const plugins = listed.plugins.map((plugin) => toPluginView(plugin, deps.addsInstructions)).sort((a, b) => a.name.localeCompare(b.name));
        last = { at: now(), plugins };
        return plugins;
      })
      .finally(() => {
        pending = null;
      });
    return pending;
  };

  return {
    list: read,
    cached: () => last?.plugins ?? null,
    running: async (pluginId) => (await read()).some((plugin) => plugin.id === pluginId && plugin.running),
    runningCached: (pluginId) => Boolean(last?.plugins.some((plugin) => plugin.id === pluginId && plugin.running)),
  };
}
