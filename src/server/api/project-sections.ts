import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

/**
 * Section names from the Project Folders plugin: a binding at
 * «…/SelfyStudio/ads/telegram» reads as «Реклама / Telegram», the way the BB
 * sidebar shows it. Without that plugin the label stays the folder name.
 */

const folderSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  hostId: z.string(),
  parentId: z.string().nullable(),
  name: z.string(),
  path: z.string(),
});
const listSchema = z.object({ folders: z.array(folderSchema) }).passthrough();

type Folder = z.infer<typeof folderSchema>;

const TTL_MS = 60_000;

export function createProjectSections(bb: Pick<BbPluginApi, "sdk">) {
  let cached: { at: number; folders: Folder[] } | null = null;
  let pending: Promise<Folder[]> | null = null;

  const load = async (): Promise<Folder[]> => {
    if (cached && Date.now() - cached.at < TTL_MS) return cached.folders;
    if (pending) return pending;
    pending = (async () => {
      try {
        const result = await bb.sdk.plugins.callRpc({ pluginId: "project-folders", method: "list", input: null, outputSchema: listSchema });
        cached = { at: Date.now(), folders: result.folders };
      } catch {
        cached = { at: Date.now(), folders: cached?.folders ?? [] };
      }
      pending = null;
      return cached.folders;
    })();
    return pending;
  };

  const normal = (path: string) => path.replace(/\/+$/, "");

  return {
    /** «Реклама / Telegram» for a binding inside sections, or null at the project root and without the plugin. */
    async sectionPath(binding: { bbProjectId: string; hostId: string; canonicalRoot: string }): Promise<string | null> {
      const folders = await load();
      const folder = folders.find((item) => item.projectId === binding.bbProjectId && item.hostId === binding.hostId && normal(item.path) === normal(binding.canonicalRoot));
      if (!folder) return null;
      const names: string[] = [];
      const seen = new Set<string>();
      let current: Folder | undefined = folder;
      while (current && !seen.has(current.id)) {
        seen.add(current.id);
        names.unshift(current.name);
        current = current.parentId ? folders.find((item) => item.id === current!.parentId) : undefined;
      }
      return names.join(" / ") || null;
    },
  };
}
