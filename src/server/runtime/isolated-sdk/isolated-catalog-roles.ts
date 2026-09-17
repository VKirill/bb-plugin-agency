import { agencyLanguage } from "../../i18n/language.js";
import { readFileSync, existsSync } from "node:fs";
import { z } from "zod";
import { fail, ok, type DomainResult } from "../../../domain";
import { catalogSkillIdSchema } from "../../../shared/contracts/ids.js";
import { hashCatalogSkillPackage } from "../prepare-run/skill-package.js";
import type { ExplicitCatalogRoles, LiveCatalogSkill, SkillCatalogPort } from "../prepare-run";
import { resolveCatalogRoles } from "./catalog-port.js";

export const ISOLATED_CATALOG_ROLES_SCHEMA = "agency-isolated-catalog-roles-v1" as const;
export const ISOLATED_CATALOG_ROLES_FILENAME = "agency-isolated-catalog-roles-v1.json";

const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const hostIdSchema = z.string().trim().regex(/^host_[a-z0-9]{8,32}$/);

const rolePinSchema = z
  .object({
    id: catalogSkillIdSchema,
    source: z.string().trim().min(1).max(80),
    hash: hashSchema,
  })
  .strict();

/**
 * `hostId` pins one machine; `hostIds` lists every machine whose projects may
 * launch with these roles. Hashes are still checked against the live catalog of
 * the binding, so a machine with a different skill package fails with a reason.
 */
export const isolatedCatalogRolesConfigSchema = z
  .object({
    schema: z.literal(ISOLATED_CATALOG_ROLES_SCHEMA),
    hostId: hostIdSchema.optional(),
    hostIds: z.array(hostIdSchema).min(1).max(16).optional(),
    core: rolePinSchema,
    helpers: z.array(rolePinSchema).min(1).max(8),
  })
  .strict()
  .refine((config) => Boolean(config.hostId) || Boolean(config.hostIds?.length), {
    message: "hostId or hostIds is required",
    path: ["hostIds"],
  });

export function configuredCatalogHosts(config: IsolatedCatalogRolesConfig): string[] {
  return [...new Set([...(config.hostId ? [config.hostId] : []), ...(config.hostIds ?? [])])];
}

export type IsolatedCatalogRolesConfig = z.infer<typeof isolatedCatalogRolesConfigSchema>;

export function parseIsolatedCatalogRolesConfig(raw: unknown): DomainResult<IsolatedCatalogRolesConfig> {
  const parsed = isolatedCatalogRolesConfigSchema.safeParse(raw);
  if (!parsed.success) {
    return fail("isolated_catalog_roles_invalid", parsed.error.message);
  }
  return ok(parsed.data);
}

export function parseIsolatedCatalogRolesJson(text: string): DomainResult<IsolatedCatalogRolesConfig> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return fail("isolated_catalog_roles_invalid", "isolated catalog roles JSON is not parseable");
  }
  return parseIsolatedCatalogRolesConfig(raw);
}

export function loadIsolatedCatalogRolesFile(path: string): DomainResult<IsolatedCatalogRolesConfig> {
  if (!existsSync(path)) {
    return fail("isolated_catalog_roles_missing", `isolated catalog roles file is missing: ${path}`);
  }
  return parseIsolatedCatalogRolesJson(readFileSync(path, "utf8"));
}

export function rolesFromIsolatedConfig(config: IsolatedCatalogRolesConfig): ExplicitCatalogRoles {
  return {
    core: { id: config.core.id, source: config.core.source },
    helpers: config.helpers.map((helper) => ({ id: helper.id, source: helper.source })),
  };
}

export async function pinCatalogRolesForPrepare(input: {
  catalog: SkillCatalogPort;
  listed: readonly LiveCatalogSkill[];
  config: IsolatedCatalogRolesConfig;
  hostId: string;
}): Promise<DomainResult<ExplicitCatalogRoles>> {
  const hosts = configuredCatalogHosts(input.config);
  if (!hosts.includes(input.hostId)) {
    return fail(
      "catalog_host_mismatch",
      `binding host ${input.hostId} is not in configured catalog hosts ${hosts.join(", ")}; add it to hostIds`,
    );
  }
  const roles = resolveCatalogRoles(input.listed, rolesFromIsolatedConfig(input.config));
  if (!roles.ok) return roles;
  const pins = [input.config.core, ...input.config.helpers];
  for (const pin of pins) {
    const listed = input.listed.find((skill) => skill.id === pin.id);
    if (!listed) {
      return fail("unknown_skill", `configured skill ${pin.id} is not in live catalog`);
    }
    if (listed.source !== pin.source) {
      return fail(
        "catalog_skill_provenance_mismatch",
        `configured ${pin.id} source ${pin.source} !== catalog ${listed.source}`,
      );
    }
    const hashed = await hashCatalogSkillPackage(input.catalog, listed);
    if (!hashed.ok) return hashed;
    if (hashed.value.source !== pin.source) {
      return fail(
        "catalog_skill_provenance_mismatch",
        `hashed ${pin.id} source ${hashed.value.source} !== configured ${pin.source}`,
      );
    }
    if (hashed.value.hash !== pin.hash) {
      // The owner edited or updated the skill: the pin is what a launch is checked against,
      // so the message says where to renew it instead of leaving two hashes to compare.
      const en = agencyLanguage() === "en";
      return fail(
        "catalog_skill_hash_mismatch",
        en
          ? `The Agency skill changed after it was pinned, so no launch passes the check. Open Settings → Machines → «Pin current versions». (${pin.id}: ${hashed.value.hash.slice(0, 8)} instead of ${pin.hash.slice(0, 8)}.)`
          : `Навык Агентства изменился после закрепления, поэтому запуск не проходит проверку. Откройте «Настройки → Машины» и нажмите «Закрепить текущие версии». (${pin.id}: ${hashed.value.hash.slice(0, 8)} вместо ${pin.hash.slice(0, 8)}.)`,
      );
    }
  }
  return ok(roles.value);
}

export function resolveIsolatedCatalogRolesPath(input: {
  settingsJson?: string;
  envFilePath?: string;
  dataDirFilePath?: string;
}): DomainResult<{ config: IsolatedCatalogRolesConfig; origin: "settings" | "env-file" | "data-dir-file" } | null> {
  const json = input.settingsJson?.trim();
  if (json) {
    const parsed = parseIsolatedCatalogRolesJson(json);
    if (!parsed.ok) return parsed;
    return ok({ config: parsed.value, origin: "settings" });
  }
  if (input.envFilePath?.trim()) {
    const loaded = loadIsolatedCatalogRolesFile(input.envFilePath.trim());
    if (!loaded.ok) return loaded;
    return ok({ config: loaded.value, origin: "env-file" });
  }
  if (input.dataDirFilePath?.trim() && existsSync(input.dataDirFilePath)) {
    const loaded = loadIsolatedCatalogRolesFile(input.dataDirFilePath);
    if (!loaded.ok) return loaded;
    return ok({ config: loaded.value, origin: "data-dir-file" });
  }
  return ok(null);
}
