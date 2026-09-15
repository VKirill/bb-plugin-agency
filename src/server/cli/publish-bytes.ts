import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

/** Reads bytes from the plugin-server process filesystem, never from a client host. */
export async function fillPublishBytesFromServerFile(
  input: Record<string, unknown>,
  bytesFile: string,
): Promise<{ ok: true; value: Record<string, unknown> } | { ok: false; message: string }> {
  try {
    const bytes = await readFile(bytesFile);
    return {
      ok: true,
      value: {
        ...input,
        bytesBase64: bytes.toString("base64"),
        size: bytes.byteLength,
        hash: createHash("sha256").update(bytes).digest("hex"),
      },
    };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}
