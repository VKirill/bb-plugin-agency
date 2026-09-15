import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  canonicalSkillPackageInventory,
  isGeneratedBytecodePath,
  skillPackageHash,
} from "./skill-package.js";

function walkRelativeFiles(root: string): string[] {
  const found: string[] = [];
  const walk = (current: string, prefix: string) => {
    const entries = readdirSync(current, { withFileTypes: true }).sort((left, right) =>
      left.name.localeCompare(right.name),
    );
    for (const entry of entries) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (isGeneratedBytecodePath(relative)) continue;
      const absolute = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(absolute, relative);
        continue;
      }
      if (entry.isFile() && !entry.isSymbolicLink()) found.push(relative);
    }
  };
  walk(root, "");
  return found;
}

/** Same inventory/hash as `hashCatalogSkillPackage` for a skill root on disk. */
export function hashSkillPackageRoot(root: string): { hash: string; files: string[] } {
  const files = canonicalSkillPackageInventory(walkRelativeFiles(root));
  return {
    files,
    hash: skillPackageHash(
      files.map((path) => ({ path, content: readFileSync(join(root, path), "utf8") })),
    ),
  };
}
