import type { BbCatalog } from "./store-commands";

/** Capability row from AGY-17 catalog or a saved profile id. Label and source are display-only. */

export type CapabilityRow = {
  id: string;
  label: string;
  source: string;
};

export type CapabilityChoice = CapabilityRow & {
  available: boolean;
};

export const DEMO_SKILL_SOURCE = "demo";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function readText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function readCapabilityRows(value: unknown): CapabilityRow[] {
  if (!Array.isArray(value)) return [];
  const rows: CapabilityRow[] = [];
  for (const item of value) {
    const record = asRecord(item);
    if (!record) continue;
    const id = readText(record.id);
    if (!id) continue;
    const label = readText(record.label) || id;
    const source = readText(record.source) || readText(record.scope) || readText(record.kind) || "catalog";
    rows.push({ id, label, source });
  }
  return rows;
}

export function mergeCapabilityChoices(
  catalog: readonly CapabilityRow[],
  savedIds: readonly string[],
  query = "",
): CapabilityChoice[] {
  const byId = new Map<string, CapabilityChoice>();
  for (const row of catalog) {
    byId.set(row.id, { ...row, available: true });
  }
  for (const id of savedIds) {
    const trimmed = id.trim();
    if (!trimmed) continue;
    const current = byId.get(trimmed);
    if (current) continue;
    byId.set(trimmed, { id: trimmed, label: trimmed, source: "saved", available: false });
  }
  const needle = query.trim().toLowerCase();
  return [...byId.values()]
    .filter((row) => {
      if (!needle) return true;
      return `${row.id} ${row.label} ${row.source}`.toLowerCase().includes(needle);
    })
    .sort((left, right) => {
      if (left.available !== right.available) return left.available ? -1 : 1;
      return left.label.localeCompare(right.label, "ru");
    });
}

export function capabilityStatusLabel(available: boolean): string {
  return available ? "в каталоге" : "нет в каталоге";
}

export function demoCapabilityRows(ids: readonly string[]): CapabilityRow[] {
  return ids.map((id) => ({ id, label: id, source: DEMO_SKILL_SOURCE }));
}

export const EMPTY_BB_CATALOG: BbCatalog = {
  projects: [],
  environments: [],
  policies: [],
  skills: [],
  mcps: [],
  skillDiscovery: "unavailable",
  mcpDiscovery: "unavailable",
};

export function normalizeBbCatalog(value: unknown): BbCatalog {
  const record = asRecord(value);
  if (!record) return { ...EMPTY_BB_CATALOG };
  return {
    projects: Array.isArray(record.projects) ? (record.projects as BbCatalog["projects"]) : [],
    environments: Array.isArray(record.environments) ? (record.environments as BbCatalog["environments"]) : [],
    policies: Array.isArray(record.policies) ? (record.policies as BbCatalog["policies"]) : [],
    skills: readCapabilityRows(record.skills ?? record.capabilities),
    mcps: readCapabilityRows(record.mcps ?? record.mcp),
    skillDiscovery: record.skillDiscovery === "sdk" ? "sdk" : "unavailable",
    mcpDiscovery: "unavailable",
  };
}
