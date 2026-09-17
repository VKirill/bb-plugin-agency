import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ok } from "../src/domain";
import { parseIsolatedCatalogRolesJson } from "../src/server/runtime/isolated-sdk/isolated-catalog-roles";
import { pinCurrentSkills, readSkillPinStatus, type SkillPinDeps } from "../src/server/runtime/isolated-sdk/skill-pin";
import type { CatalogSkillId } from "../src/shared/contracts/ids";

const CORE = `skill_${"a".repeat(64)}` as CatalogSkillId;
const HELPER = `skill_${"b".repeat(64)}` as CatalogSkillId;

function setup(origin: "data-dir-file" | "env-file", skillText = "# Agency v2") {
  const dir = mkdtempSync(join(tmpdir(), "agy-pin-"));
  const path = join(dir, "roles.json");
  writeFileSync(
    path,
    JSON.stringify({
      schema: "agency-isolated-catalog-roles-v1",
      hostIds: ["host_minimini1"],
      core: { id: CORE, source: "plugin:agency", hash: "0".repeat(64) },
      helpers: [{ id: HELPER, source: "bb-user", hash: "1".repeat(64) }],
    }),
  );
  const contents: Record<string, string> = { [CORE]: skillText, [HELPER]: "# Helper" };
  const deps: SkillPinDeps = {
    catalog: {
      list: async () => ok([
        { id: CORE, name: "agency", pluginId: "agency", source: "plugin:agency" },
        { id: HELPER, name: "ru-check", pluginId: "", source: "bb-user" },
      ]),
      listFiles: async () => ok(["SKILL.md"]),
      getContent: async (id) => ok(contents[id]!),
    },
    scope: () => ({ projectId: "proj_1", environmentId: "env_1", hostId: "host_minimini1" }),
    load: async () => {
      const parsed = parseIsolatedCatalogRolesJson(readFileSync(path, "utf8"));
      return parsed.ok ? ok({ config: parsed.value, origin }) : parsed;
    },
    dataDirFilePath: path,
    writeSettings: async () => undefined,
    now: () => new Date("2026-09-17T10:00:00.000Z"),
  };
  return { dir, path, deps };
}

describe("agency skill pins", () => {
  it("shows pinned against current hashes and pins the current package with a backup", async () => {
    const { dir, path, deps } = setup("data-dir-file");
    const before = await readSkillPinStatus(deps);
    expect(before.ok && before.value.inSync).toBe(false);
    expect(before.ok && before.value.rows.map((row) => row.name)).toEqual(["agency", "ru-check"]);
    const pinned = await pinCurrentSkills(deps);
    expect(pinned.ok && pinned.value.inSync).toBe(true);
    const written = JSON.parse(readFileSync(path, "utf8"));
    expect(written.core.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(written.core.hash).not.toBe("0".repeat(64));
    expect(written.hostIds).toEqual(["host_minimini1"]);
    expect(readdirSync(dir).some((name) => name.startsWith("roles.json.bak-"))).toBe(true);
  });

  it("does not rewrite a config that comes from the environment", async () => {
    const { deps } = setup("env-file");
    const result = await pinCurrentSkills(deps);
    expect(result.ok ? null : result.error.code).toBe("skill_pin_not_editable");
  });
});
