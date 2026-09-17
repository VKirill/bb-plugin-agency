import { assertBindingActive, fail, ok, type DomainResult } from "../../domain";
import { callBoundFileOp, type HostFileRpcClient } from "../../host";
import type { ProjectBinding } from "../../shared/contracts";

/** The file every launch reads as project rules (see launch-rpc DEFAULT_APPLICABLE). */
export const PROJECT_RULES_PATH = ".bb/AGENTS.md";
/** project-folders keeps its own template block between these markers. */
export const PROJECT_FOLDERS_BLOCK_START = "<!-- bb-project-folders:agents:start -->";
export const PROJECT_RULES_MAX_BYTES = 256 * 1024;

export type ProjectRulesRecord = {
  bindingId: string;
  relativePath: string;
  exists: boolean;
  text: string | null;
  hash: string | null;
  size: number | null;
  managedBlock: boolean;
};

/** Read the rules file on the binding's machine through the host entry. */
export async function readProjectRulesFile(
  documents: HostFileRpcClient,
  binding: ProjectBinding,
): Promise<DomainResult<ProjectRulesRecord>> {
  const base = { bindingId: binding.id, relativePath: PROJECT_RULES_PATH };
  const stat = await callBoundFileOp(documents, binding, { op: "stat", relativePath: PROJECT_RULES_PATH });
  if (!stat.ok) return stat;
  if (stat.value.missing) {
    return ok({ ...base, exists: false, text: null, hash: null, size: null, managedBlock: false });
  }
  const read = await callBoundFileOp(documents, binding, { op: "read", relativePath: PROJECT_RULES_PATH });
  if (!read.ok) return read;
  const text = Buffer.from(read.value.bytesBase64 ?? "", "base64").toString("utf8");
  return ok({
    ...base,
    exists: true,
    text,
    hash: read.value.hash ?? null,
    size: read.value.size ?? null,
    managedBlock: text.includes(PROJECT_FOLDERS_BLOCK_START),
  });
}

/** Replace the rules file only if it still has the hash the editor opened. */
export async function saveProjectRulesFile(
  documents: HostFileRpcClient,
  binding: ProjectBinding,
  input: { text: string; expectedHash: string | null },
): Promise<DomainResult<{ bindingId: string; relativePath: string; hash: string; size: number }>> {
  const active = assertBindingActive(binding);
  if (!active.ok) return active;
  const bytes = Buffer.from(input.text, "utf8");
  if (bytes.byteLength > PROJECT_RULES_MAX_BYTES) {
    return fail("rules_too_large", `project rules are limited to ${PROJECT_RULES_MAX_BYTES} bytes`);
  }
  const replaced = await callBoundFileOp(documents, binding, {
    op: "replace",
    relativePath: PROJECT_RULES_PATH,
    bytesBase64: bytes.toString("base64"),
    expectedHash: input.expectedHash,
  });
  if (!replaced.ok) return replaced;
  if (!replaced.value.hash || replaced.value.size === undefined) {
    return fail("host_file_error", "host did not report the saved file hash");
  }
  return ok({ bindingId: binding.id, relativePath: PROJECT_RULES_PATH, hash: replaced.value.hash, size: replaced.value.size });
}
