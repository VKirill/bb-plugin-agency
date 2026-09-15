/** Exact continuation token on a typed text field. Not JSON.stringify of the envelope. */
export function textHoldsExactToken(text: unknown, token: string): boolean {
  if (typeof text !== "string" || !token) return false;
  return text.split(/\r?\n/).some((line) => line.trim() === token);
}

function readString(record: object, key: string): string | undefined {
  const value = Reflect.get(record, key);
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function queuedMessageHoldsToken(row: object, token: string, queuedMessageId?: string | null): boolean {
  const id = readString(row, "id");
  if (queuedMessageId && id === queuedMessageId) return true;
  const content = Reflect.get(row, "content");
  if (!Array.isArray(content)) return false;
  return content.some((part) => {
    if (!part || typeof part !== "object") return false;
    return Reflect.get(part, "type") === "text" && textHoldsExactToken(Reflect.get(part, "text"), token);
  });
}

export function isDispatchedUserRow(row: object, token: string): boolean {
  if (Reflect.get(row, "kind") !== "conversation") return false;
  if (Reflect.get(row, "role") !== "user") return false;
  if (!textHoldsExactToken(Reflect.get(row, "text"), token)) return false;
  const turn = Reflect.get(row, "turnRequest");
  if (!turn || typeof turn !== "object") return false;
  return Reflect.get(turn, "status") === "accepted";
}

export function listObjects(value: unknown): object[] {
  if (Array.isArray(value)) {
    return value.filter((row): row is object => Boolean(row) && typeof row === "object");
  }
  if (value && typeof value === "object") {
    const rows = Reflect.get(value, "rows");
    if (Array.isArray(rows)) {
      return rows.filter((row): row is object => Boolean(row) && typeof row === "object");
    }
  }
  return [];
}

export function readQueuedMessageId(result: object): string | undefined {
  const queued = Reflect.get(result, "queuedMessage");
  if (!queued || typeof queued !== "object") return undefined;
  return readString(queued, "id");
}
