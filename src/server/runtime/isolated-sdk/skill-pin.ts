import { copyFileSync, existsSync, renameSync, writeFileSync } from "node:fs";
import { fail, ok, type DomainResult } from "../../../domain";
import { hashCatalogSkillPackage } from "../prepare-run/skill-package.js";
import type { SkillCatalogPort, SkillCatalogScope } from "../prepare-run";
import { configuredCatalogHosts, type IsolatedCatalogRolesConfig } from "./isolated-catalog-roles.js";

/**
 * Pinning the Agency skills. A launch checks each configured skill against the
 * hash pinned in the roles config; after a skill update the owner re-pins the
 * current package with one action instead of computing hashes by hand.
 */

export type SkillPinOrigin = "settings" | "env-file" | "data-dir-file" | "none";

export type SkillPinRow = {
  role: "core" | "helper";
  id: string;
  name: string | null;
  source: string;
  pinnedHash: string;
  currentHash: string | null;
  /** Why the current hash could not be read. */
  problem: string | null;
};

export type SkillPinStatus = {
  origin: SkillPinOrigin;
  /** Only a file in the plugin data folder or the plugin setting can be re-pinned from here. */
  editable: boolean;
  hostIds: string[];
  rows: SkillPinRow[];
  inSync: boolean;
  note: string | null;
};

export type SkillPinDeps = {
  isActive?: () => boolean;
  catalog: SkillCatalogPort;
  /** A project scope to list the catalog in; null when no project is connected. */
  scope: () => SkillCatalogScope | null;
  load: () => Promise<DomainResult<{ config: IsolatedCatalogRolesConfig; origin: Exclude<SkillPinOrigin, "none"> } | null>>;
  /** Path of the data-folder file, used when that is the origin. */
  dataDirFilePath: string;
  writeSettings: (json: string) => Promise<void>;
  now: () => Date;
};

export async function readSkillPinStatus(deps: SkillPinDeps): Promise<DomainResult<SkillPinStatus>> {
  if (deps.isActive?.() === false) return fail("runtime_disposed", "Runtime was disposed");
  const loaded = await deps.load();
  if (deps.isActive?.() === false) return fail("runtime_disposed", "Runtime was disposed");
  if (!loaded.ok) return loaded;
  if (!loaded.value) {
    return ok({ origin: "none", editable: false, hostIds: [], rows: [], inSync: true, note: "Закрепление не настроено: запуски берут навыки из каталога без проверки версии." });
  }
  const { config, origin } = loaded.value;
  const scope = deps.scope();
  const listed = scope ? await deps.catalog.list(scope) : null;
  const pins = [
    { role: "core" as const, pin: config.core },
    ...config.helpers.map((pin) => ({ role: "helper" as const, pin })),
  ];
  const rows: SkillPinRow[] = [];
  for (const { role, pin } of pins) {
    const base = { role, id: pin.id, source: pin.source, pinnedHash: pin.hash };
    if (!listed) {
      rows.push({ ...base, name: null, currentHash: null, problem: "Нет подключённого проекта: каталог навыков не прочитать." });
      continue;
    }
    if (!listed.ok) {
      rows.push({ ...base, name: null, currentHash: null, problem: listed.error.message });
      continue;
    }
    const skill = listed.value.find((item) => item.id === pin.id);
    if (!skill) {
      rows.push({ ...base, name: null, currentHash: null, problem: "Навык не найден в каталоге BB." });
      continue;
    }
    if (deps.isActive?.() === false) return fail("runtime_disposed", "Runtime was disposed");
    const hashed = await hashCatalogSkillPackage(deps.catalog, skill);
    rows.push({
      ...base,
      name: skill.name,
      currentHash: hashed.ok ? hashed.value.hash : null,
      problem: hashed.ok ? null : hashed.error.message,
    });
  }
  return ok({
    origin,
    editable: origin === "data-dir-file" || origin === "settings",
    hostIds: configuredCatalogHosts(config),
    rows,
    inSync: rows.every((row) => row.currentHash === row.pinnedHash),
    note: origin === "env-file" ? "Конфигурация задана переменной окружения AGENCY_ISOLATED_CATALOG_ROLES_FILE: закрепите версию в том файле." : null,
  });
}

/** Writes the current package hashes into the roles config. Every row must be readable. */
export async function pinCurrentSkills(deps: SkillPinDeps): Promise<DomainResult<SkillPinStatus>> {
  const status = await readSkillPinStatus(deps);
  if (deps.isActive?.() === false) return fail("runtime_disposed", "Runtime was disposed");
  if (!status.ok) return status;
  if (!status.value.editable) {
    return fail("skill_pin_not_editable", status.value.note ?? "Закрепление не настроено.");
  }
  const unreadable = status.value.rows.find((row) => !row.currentHash);
  if (unreadable) {
    return fail("skill_pin_unreadable", `Навык ${unreadable.name ?? unreadable.id}: ${unreadable.problem ?? "текущая версия не прочитана"}`);
  }
  if (status.value.inSync) return status;
  if (deps.isActive?.() === false) return fail("runtime_disposed", "Runtime was disposed");
  const loaded = await deps.load();
  if (deps.isActive?.() === false) return fail("runtime_disposed", "Runtime was disposed");
  if (!loaded.ok) return loaded;
  if (!loaded.value) return fail("skill_pin_not_editable", "Закрепление не настроено.");
  const hashOf = (id: string) => status.value.rows.find((row) => row.id === id)!.currentHash!;
  const next: IsolatedCatalogRolesConfig = {
    ...loaded.value.config,
    core: { ...loaded.value.config.core, hash: hashOf(loaded.value.config.core.id) },
    helpers: loaded.value.config.helpers.map((helper) => ({ ...helper, hash: hashOf(helper.id) })),
  };
  const json = `${JSON.stringify(next, null, 2)}\n`;
  if (loaded.value.origin === "settings") {
    await deps.writeSettings(json);
  } else {
    const path = deps.dataDirFilePath;
    const stamp = deps.now().toISOString().replace(/[:.]/g, "-");
    if (existsSync(path)) copyFileSync(path, `${path}.bak-${stamp}`);
    const temp = `${path}.tmp-${stamp}`;
    writeFileSync(temp, json, "utf8");
    renameSync(temp, path);
  }
  return readSkillPinStatus(deps);
}
