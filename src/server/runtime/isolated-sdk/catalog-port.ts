import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { fail, ok, type DomainResult } from "../../../domain";
import type { CatalogSkillId } from "../../../shared/contracts/ids.js";
import {
  selectCatalogRoles,
  type ExplicitCatalogRoles,
  type LiveCatalogSkill,
  type SkillCatalogPort,
  type SkillCatalogScope,
} from "../prepare-run";

export type IsolatedSkillsApi = Pick<BbPluginApi["sdk"]["skills"], "list" | "listFiles" | "getContent">;

function catalogSource(skill: { pluginId: string | null; scope: string }): string {
  return skill.pluginId ? `plugin:${skill.pluginId}` : skill.scope;
}

export function createSdkSkillCatalogPort(skills: IsolatedSkillsApi): SkillCatalogPort {
  let lastScope: SkillCatalogScope | null = null;
  return {
    async list(scope: SkillCatalogScope): Promise<DomainResult<readonly LiveCatalogSkill[]>> {
      lastScope = scope;
      try {
        const listed = await skills.list({
          projectId: scope.projectId,
          environmentId: scope.environmentId,
        });
        return ok(
          listed.skills.map((skill) => ({
            id: skill.id as CatalogSkillId,
            name: skill.name,
            pluginId: skill.pluginId ?? "",
            source: catalogSource(skill),
            filePath: skill.filePath,
          })),
        );
      } catch (error) {
        return fail("capability_catalog_unavailable", error instanceof Error ? error.message : String(error));
      }
    },
    async listFiles(id: CatalogSkillId): Promise<DomainResult<readonly string[]>> {
      if (!lastScope) return fail("catalog_scope_missing", "skills.list must run before listFiles");
      try {
        const files = await skills.listFiles({
          projectId: lastScope.projectId,
          environmentId: lastScope.environmentId,
          skillId: id,
        });
        return ok(files.files);
      } catch (error) {
        return fail("skill_files_unavailable", error instanceof Error ? error.message : String(error));
      }
    },
    async getContent(id: CatalogSkillId, path: string): Promise<DomainResult<string>> {
      if (!lastScope) return fail("catalog_scope_missing", "skills.list must run before getContent");
      try {
        const content = await skills.getContent({
          projectId: lastScope.projectId,
          environmentId: lastScope.environmentId,
          skillId: id,
          path,
        });
        return ok(content.content);
      } catch (error) {
        return fail("skill_content_unavailable", error instanceof Error ? error.message : String(error));
      }
    },
  };
}

export function catalogRolesFromListed(listed: readonly LiveCatalogSkill[]): DomainResult<ExplicitCatalogRoles> {
  const cores = listed.filter((skill) => skill.source === "plugin:agency");
  const helpers = listed.filter((skill) => skill.source === "plugin:agency-artifacts");
  if (cores.length !== 1) {
    return fail(
      "catalog_role_unresolved",
      `need exactly one plugin:agency skill, found ${cores.length}; roles are id+source, not name`,
    );
  }
  if (helpers.length !== 1) {
    return fail(
      "catalog_role_unresolved",
      `need exactly one plugin:agency-artifacts helper, found ${helpers.length}; unique bb-user by name is not a fallback`,
    );
  }
  return ok({
    core: { id: cores[0].id, source: cores[0].source },
    helpers: [{ id: helpers[0].id, source: helpers[0].source }],
  });
}

/** Explicit configured id+source is matched against the live list. No silent by-name choice. */
export function resolveCatalogRoles(
  listed: readonly LiveCatalogSkill[],
  explicit?: ExplicitCatalogRoles,
): DomainResult<ExplicitCatalogRoles> {
  if (explicit) {
    const selected = selectCatalogRoles(listed, [], explicit);
    if (!selected.ok) return selected;
    return ok(explicit);
  }
  return catalogRolesFromListed(listed);
}
