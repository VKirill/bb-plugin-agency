const OMITTED = { omitted: true, reason: "bounded-cli" } as const;

function shouldOmitKey(key: string): boolean {
  if (key === "secretRefs") return false;
  if (key === "bytesBase64" || key === "logBytes" || key === "bytes") return true;
  return /^(secret|token|cookie|password|authorization)$/i.test(key);
}

export function redactCliValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactCliValue);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      out[key] = shouldOmitKey(key) ? OMITTED : redactCliValue(nested);
    }
    return out;
  }
  return value;
}

/** Complete machine JSON. Do not slice structured output; transport owns size. */
export function encodeCliJson(value: unknown): string {
  return `${JSON.stringify(redactCliValue(value), null, 2)}\n`;
}

export function cliFailure(code: string, message: string): { exitCode: 1; stdout: string; stderr: string } {
  const body = { ok: false as const, error: { code, message } };
  return { exitCode: 1, stdout: encodeCliJson(body), stderr: `${code}: ${message}` };
}
