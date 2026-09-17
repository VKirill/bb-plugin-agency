import { describe, expect, it } from "vitest";
import type { CatalogSkillId } from "../src/shared/contracts/ids";
import type { LiveCatalogSkill, SkillCatalogPort } from "../src/server/runtime/prepare-run";
import { hashCatalogSkillPackage } from "../src/server/runtime/prepare-run/skill-package";
import {
  parseIsolatedCatalogRolesJson,
  pinCatalogRolesForPrepare,
  resolveIsolatedCatalogRolesPath,
  type IsolatedCatalogRolesConfig,
} from "../src/server/runtime/isolated-sdk/isolated-catalog-roles";

const CORE = "skill_6153a163fb7fac8c435f3befc88db8417cd0722ba8fdf5ecc37b2b5069ffc3ff" as CatalogSkillId;
const HELPER = "skill_dffe1cd2f2383daa12071a937fd19eeb3536bbb5d773a01bf4ce2bd91103ff1d" as CatalogSkillId;
const UNKNOWN = "skill_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as CatalogSkillId;
const HOST = "host_j9p6y79cyt";

function memoryCatalog(
  packages: Record<string, { listed: LiveCatalogSkill; files: Record<string, string> }>,
): SkillCatalogPort {
  return {
    async list() {
      return { ok: true, value: Object.values(packages).map((item) => item.listed) };
    },
    async listFiles(id) {
      const pack = packages[id];
      if (!pack) return { ok: false, error: { code: "unknown_skill", message: id } };
      return { ok: true, value: Object.keys(pack.files) };
    },
    async getContent(id, path) {
      const content = packages[id]?.files[path];
      if (content === undefined) return { ok: false, error: { code: "skill_file_missing", message: path } };
      return { ok: true, value: content };
    },
  };
}

function packs(helperSource = "bb-user"): Record<string, { listed: LiveCatalogSkill; files: Record<string, string> }> {
  return {
    [CORE]: {
      listed: { id: CORE, name: "agency", pluginId: "agency", source: "plugin:agency" },
      files: { "SKILL.md": "# Agency\nSee [notes](notes.md).", "notes.md": "notes" },
    },
    [HELPER]: {
      listed: { id: HELPER, name: "agency-artifacts", pluginId: "", source: helperSource },
      files: {
        "SKILL.md": "# Helper\nUse [tpl](templates.md).",
        "templates.md": "tpl",
      },
    },
  };
}

async function configFor(
  catalog: SkillCatalogPort,
  listed: LiveCatalogSkill[],
  over: Partial<IsolatedCatalogRolesConfig> = {},
): Promise<IsolatedCatalogRolesConfig> {
  const coreHash = await hashCatalogSkillPackage(catalog, listed[0]);
  const helperHash = await hashCatalogSkillPackage(catalog, listed[1]);
  if (!coreHash.ok || !helperHash.ok) throw new Error("hash fixtures");
  return {
    schema: "agency-isolated-catalog-roles-v1",
    hostId: HOST,
    core: { id: CORE, source: "plugin:agency", hash: coreHash.value.hash },
    helpers: [{ id: HELPER, source: listed[1].source, hash: helperHash.value.hash }],
    ...over,
  };
}

describe("isolated catalog roles config", () => {
  it("accepts configured bb-user helper id+source+host+hash", async () => {
    const packages = packs("bb-user");
    const catalog = memoryCatalog(packages);
    const listed = Object.values(packages).map((item) => item.listed);
    const config = await configFor(catalog, listed);
    const pinned = await pinCatalogRolesForPrepare({ catalog, listed, config, hostId: HOST });
    expect(pinned.ok).toBe(true);
    if (!pinned.ok) throw new Error(pinned.error.message);
    expect(pinned.value.helpers[0].source).toBe("bb-user");
    expect(pinned.value.helpers[0].id).toBe(HELPER);
  });

  it("rejects foreign source and unknown id", async () => {
    const packages = packs("bb-user");
    const catalog = memoryCatalog(packages);
    const listed = Object.values(packages).map((item) => item.listed);
    const good = await configFor(catalog, listed);
    const foreign = await pinCatalogRolesForPrepare({
      catalog,
      listed,
      config: {
        ...good,
        helpers: [{ ...good.helpers[0], source: "plugin:impostor" }],
      },
      hostId: HOST,
    });
    expect(foreign.ok).toBe(false);
    if (foreign.ok) throw new Error("expected foreign source reject");
    expect(foreign.error.code).toBe("catalog_skill_provenance_mismatch");

    const unknown = await pinCatalogRolesForPrepare({
      catalog,
      listed,
      config: {
        ...good,
        helpers: [{ id: UNKNOWN, source: "bb-user", hash: good.helpers[0].hash }],
      },
      hostId: HOST,
    });
    expect(unknown.ok).toBe(false);
    if (unknown.ok) throw new Error("expected unknown id reject");
    expect(unknown.error.code).toBe("unknown_skill");
  });

  it("rejects host mismatch and package hash mismatch", async () => {
    const packages = packs("bb-user");
    const catalog = memoryCatalog(packages);
    const listed = Object.values(packages).map((item) => item.listed);
    const good = await configFor(catalog, listed);
    const host = await pinCatalogRolesForPrepare({
      catalog,
      listed,
      config: good,
      hostId: "host_otherhost1",
    });
    expect(host.ok).toBe(false);
    if (!host.ok) expect(host.error.code).toBe("catalog_host_mismatch");

    const listedHosts = await pinCatalogRolesForPrepare({
      catalog,
      listed,
      config: { ...good, hostId: undefined, hostIds: [HOST, "host_otherhost1"] },
      hostId: "host_otherhost1",
    });
    expect(listedHosts.ok).toBe(true);

    const hash = await pinCatalogRolesForPrepare({
      catalog,
      listed,
      config: {
        ...good,
        helpers: [{ ...good.helpers[0], hash: "ab".repeat(32) }],
      },
      hostId: HOST,
    });
    expect(hash.ok).toBe(false);
    if (!hash.ok) expect(hash.error.code).toBe("catalog_skill_hash_mismatch");
  });

  it("parses bounded schema and prefers settings over files", () => {
    const bad = parseIsolatedCatalogRolesJson(`{"schema":"nope"}`);
    expect(bad.ok).toBe(false);
    const resolved = resolveIsolatedCatalogRolesPath({
      settingsJson: "",
      envFilePath: "",
      dataDirFilePath: "/no/such/agency-isolated-catalog-roles-v1.json",
    });
    expect(resolved.ok).toBe(true);
    if (resolved.ok) expect(resolved.value).toBeNull();
  });
});
