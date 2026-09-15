import { readFile } from "node:fs/promises";
import { ARTIFACT_UPLOAD_MAX_BASE64 } from "../../shared/rpc-contract";
import type { CliFlags } from "./parse";

const MAX_INLINE = ARTIFACT_UPLOAD_MAX_BASE64 + 65_536;

export const SERVER_FS_SOURCE = "server-fs";

export const FILE_SOURCE_REQUIRED =
  "bb CLI run is the plugin server process. --input-file/--bytes-file read that machine only; pass --source server-fs. Prefer --input-json (source=inline).";

function parseObjectJson(raw: string, label: string): { ok: true; value: Record<string, unknown> } | { ok: false; message: string } {
  if (raw.length > MAX_INLINE) return { ok: false, message: `${label} exceeds ${MAX_INLINE} bytes` };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, message: `${label} must be a JSON object` };
    }
    return { ok: true, value: parsed as Record<string, unknown> };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

export async function loadCliPayload(
  flags: CliFlags,
): Promise<{ ok: true; value: Record<string, unknown> } | { ok: false; message: string }> {
  if (flags.inputJson && flags.inputFile) {
    return { ok: false, message: "use either --input-json or --input-file, not both" };
  }
  if (flags.inputFile || flags.bytesFile) {
    if (flags.source !== SERVER_FS_SOURCE) return { ok: false, message: FILE_SOURCE_REQUIRED };
  } else if (flags.source) {
    return { ok: false, message: "--source is only valid with --input-file or --bytes-file" };
  }

  if (flags.inputJson) return parseObjectJson(flags.inputJson, "--input-json");
  if (flags.inputFile) {
    try {
      const raw = await readFile(flags.inputFile, "utf8");
      return parseObjectJson(raw, "--input-file");
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  }
  return { ok: true, value: {} };
}
