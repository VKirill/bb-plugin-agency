import { fail, ok, type DomainResult } from "../../../domain";
import { catalogSkillIdSchema, type CatalogSkillId } from "../../../shared/contracts/ids.js";
import type { LiveCatalogSkill } from "./ports.js";

export type ExplicitCatalogRoleRef = {
  id: CatalogSkillId;
  source: string;
};

export type ExplicitCatalogRoles = {
  core: ExplicitCatalogRoleRef;
  helpers: readonly ExplicitCatalogRoleRef[];
};

export type SelectedCatalogRoles = {
  coreSkillIds: CatalogSkillId[];
  helperSkillIds: CatalogSkillId[];
  methodSkillIds: CatalogSkillId[];
};

function indexCatalog(catalog: readonly LiveCatalogSkill[]): DomainResult<Map<CatalogSkillId, LiveCatalogSkill>> {
  const index = new Map<CatalogSkillId, LiveCatalogSkill>();
  for (const skill of catalog) {
    const parsed = catalogSkillIdSchema.safeParse(skill.id);
    if (!parsed.success) {
      return fail("invalid_catalog_skill_id", `catalog skill id is not skill_+64hex: ${skill.id}`);
    }
    if (!skill.source.trim()) {
      return fail("catalog_skill_source_required", `catalog skill ${skill.id} source is required provenance`);
    }
    const existing = index.get(skill.id);
    if (existing && existing.source !== skill.source) {
      return fail(
        "catalog_skill_collision",
        `catalog skill ${skill.id} has conflicting provenance ${existing.source} !== ${skill.source}`,
      );
    }
    if (!existing) index.set(skill.id, skill);
  }
  return ok(index);
}

function requireRef(
  index: Map<CatalogSkillId, LiveCatalogSkill>,
  ref: ExplicitCatalogRoleRef,
  role: "core" | "helper",
): DomainResult<LiveCatalogSkill> {
  const parsed = catalogSkillIdSchema.safeParse(ref.id);
  if (!parsed.success) {
    return fail("invalid_catalog_skill_id", `${role} skill id is not skill_+64hex: ${ref.id}`);
  }
  if (!ref.source.trim()) {
    return fail("catalog_skill_source_required", `${role} skill ${ref.id} source provenance is required`);
  }
  const listed = index.get(ref.id);
  if (!listed) {
    return fail("unknown_skill", `${role} skill ${ref.id} is not in live catalog`);
  }
  if (listed.source !== ref.source) {
    return fail(
      "catalog_skill_provenance_mismatch",
      `${role} skill ${ref.id} source ${ref.source} !== catalog ${listed.source}`,
    );
  }
  return ok(listed);
}

export function selectCatalogRoles(
  catalog: readonly LiveCatalogSkill[],
  agentSkillIds: readonly CatalogSkillId[],
  explicit: ExplicitCatalogRoles,
): DomainResult<SelectedCatalogRoles> {
  const index = indexCatalog(catalog);
  if (!index.ok) return index;
  if (!explicit.helpers || explicit.helpers.length === 0) {
    return fail(
      "helper_skill_required",
      "explicit helper skill refs are required; agent-only skillIds are not enough",
    );
  }
  const core = requireRef(index.value, explicit.core, "core");
  if (!core.ok) return core;

  const helperIds: CatalogSkillId[] = [];
  const seenHelpers = new Set<string>();
  for (const ref of explicit.helpers) {
    if (ref.id === explicit.core.id) {
      return fail("skill_role_conflict", `skill listed as both core and helper: ${ref.id}`);
    }
    if (seenHelpers.has(ref.id)) {
      return fail("duplicate_helper_skill", `helper skill listed more than once: ${ref.id}`);
    }
    seenHelpers.add(ref.id);
    const helper = requireRef(index.value, ref, "helper");
    if (!helper.ok) return helper;
    helperIds.push(helper.value.id);
  }

  for (const id of agentSkillIds) {
    if (!index.value.has(id)) {
      return fail("unknown_skill", `agentVersion.skillIds entry is not in live catalog: ${id}`);
    }
  }
  const selected = new Set<string>([core.value.id, ...helperIds]);
  const methodSkillIds = agentSkillIds.filter((id) => !selected.has(id));
  return ok({
    coreSkillIds: [core.value.id],
    helperSkillIds: helperIds,
    methodSkillIds,
  });
}
