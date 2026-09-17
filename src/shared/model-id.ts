/** `claude-opus-5[1m]` and `claude-haiku-4-5-20251001` are the same model as `claude-opus-5`. */
export function normalizeModelId(model: string): string {
  return model
    .trim()
    .toLowerCase()
    .replace(/\[[^\]]*\]$/, "")
    .replace(/-\d{8}$/, "");
}
