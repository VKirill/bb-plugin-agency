import { fail, ok, type DomainResult } from "../../domain";
import { callBoundFileOp, type HostFileRpcClient } from "../../host";
import type { ProjectBinding } from "../../shared/contracts";
import { formatIdeaMarkdown } from "./format";
import type { IdeaRecord } from "./store";

export const IDEA_FILE_MAX_BYTES = 256 * 1024;

export async function writeIdeaFile(
  documents: HostFileRpcClient,
  binding: ProjectBinding,
  item: IdeaRecord,
): Promise<DomainResult<{ hash: string; size: number; relativePath: string }>> {
  const text = formatIdeaMarkdown(item);
  const bytes = Buffer.from(text, "utf8");
  if (bytes.byteLength > IDEA_FILE_MAX_BYTES) {
    return fail("idea_too_large", `idea files are limited to ${IDEA_FILE_MAX_BYTES} bytes`);
  }
  const replaced = await callBoundFileOp(documents, binding, {
    op: "replace",
    relativePath: item.relativePath,
    bytesBase64: bytes.toString("base64"),
    expectedHash: item.fileHash,
  });
  if (!replaced.ok) return replaced;
  if (!replaced.value.hash) return fail("host_file_error", "host did not report the saved idea hash");
  return ok({ hash: replaced.value.hash, size: replaced.value.size ?? bytes.byteLength, relativePath: item.relativePath });
}

export function ideaProjectPath(binding: ProjectBinding, relativePath: string): string {
  return `${binding.canonicalRoot.replace(/\/$/, "")}/${relativePath}`;
}
