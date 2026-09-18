import type { DomainResult } from "../../../domain";
import type { CatalogSkillId } from "../../../shared/contracts/ids.js";

export type LiveCatalogSkill = {
  id: CatalogSkillId;
  name: string;
  /** Строка из SKILL.md: по одному имени не понять, для чего навык. */
  description?: string;
  pluginId: string;
  source: string;
  filePath?: string;
};

export type SkillCatalogScope = {
  projectId: string;
  environmentId: string;
  hostId: string;
};

export type SkillCatalogPort = {
  list(scope: SkillCatalogScope): Promise<DomainResult<readonly LiveCatalogSkill[]>>;
  listFiles(id: CatalogSkillId): Promise<DomainResult<readonly string[]>>;
  getContent(id: CatalogSkillId, path: string): Promise<DomainResult<string>>;
};
