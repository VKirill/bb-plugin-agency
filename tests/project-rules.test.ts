import { mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hashBytes } from "../src/host/guarded-fs";
import { handleHostFileOp } from "../src/host/file-handlers";
import type { HostFileRpcClient } from "../src/host";
import { readProjectRulesFile, saveProjectRulesFile, PROJECT_RULES_PATH } from "../src/server/api/project-rules";
import type { ProjectBinding } from "../src/shared/contracts";

const roots: string[] = [];
afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function projectRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "agency-rules-"));
  roots.push(dir);
  return dir;
}

/** The host entry run in-process: same handler the machine of the binding runs. */
const localHost: HostFileRpcClient = { call: (_method, input) => handleHostFileOp(input) };

function binding(root: string, archivedAt?: string): ProjectBinding {
  return {
    id: "bnd_rules001",
    bbProjectId: "proj_trusted",
    environmentId: "env_rules001",
    hostId: "host_mini",
    canonicalRoot: root,
    policyVersionId: "pol_rules001",
    sectionId: null,
    revision: 1,
    updatedAt: "2026-09-16T00:00:00.000Z",
    ...(archivedAt ? { archivedAt } : {}),
  };
}

describe("project rules file", () => {
  it("reports a missing file, creates it, and refuses to overwrite a newer version", async () => {
    const root = await projectRoot();
    const missing = await readProjectRulesFile(localHost, binding(root));
    expect(missing).toMatchObject({ ok: true, value: { exists: false, text: null, hash: null } });

    const created = await saveProjectRulesFile(localHost, binding(root), { text: "# Правила\n", expectedHash: null });
    expect(created.ok).toBe(true);
    expect(await readFile(join(root, PROJECT_RULES_PATH), "utf8")).toBe("# Правила\n");

    const opened = await readProjectRulesFile(localHost, binding(root));
    if (!opened.ok) throw new Error(opened.error.message);
    expect(opened.value).toMatchObject({ exists: true, text: "# Правила\n", managedBlock: false });

    await writeFile(join(root, PROJECT_RULES_PATH), "# Правка в консоли\n");
    const stale = await saveProjectRulesFile(localHost, binding(root), { text: "# Моя правка\n", expectedHash: opened.value.hash });
    expect(stale).toMatchObject({ ok: false, error: { code: "file_changed" } });
    expect(await readFile(join(root, PROJECT_RULES_PATH), "utf8")).toBe("# Правка в консоли\n");

    const fresh = hashBytes(Buffer.from("# Правка в консоли\n"));
    const saved = await saveProjectRulesFile(localHost, binding(root), { text: "# Моя правка\n", expectedHash: fresh });
    expect(saved).toMatchObject({ ok: true, value: { hash: hashBytes(Buffer.from("# Моя правка\n")) } });
  });

  it("edits the shared file through a symlink inside the project and flags the project-folders block", async () => {
    const root = await projectRoot();
    await writeFile(join(root, "AGENTS.md"), "# Общие правила\n<!-- bb-project-folders:agents:start -->\nблок\n<!-- bb-project-folders:agents:end -->\n");
    await mkdir(join(root, ".bb"));
    await symlink("../AGENTS.md", join(root, PROJECT_RULES_PATH));
    const opened = await readProjectRulesFile(localHost, binding(root));
    if (!opened.ok) throw new Error(opened.error.message);
    expect(opened.value.managedBlock).toBe(true);
    const text = `# Обновлённые правила\n${opened.value.text?.split("\n").slice(1).join("\n")}`;
    const saved = await saveProjectRulesFile(localHost, binding(root), { text, expectedHash: opened.value.hash });
    expect(saved.ok).toBe(true);
    expect(await readFile(join(root, "AGENTS.md"), "utf8")).toBe(text);
  });

  it("keeps rules read-only for a disconnected project", async () => {
    const root = await projectRoot();
    const refused = await saveProjectRulesFile(localHost, binding(root, "2026-09-16T00:00:00.000Z"), { text: "x", expectedHash: null });
    expect(refused).toMatchObject({ ok: false, error: { code: "binding_archived" } });
  });
});
