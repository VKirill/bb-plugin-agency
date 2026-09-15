/**
 * Short form of an agent name for narrow places: the task rail and subtask rows.
 *
 * Catalog names often repeat the role, as in "Проверяющий — Opus". The role is
 * already given by the label next to the value, so only the tail is kept. Names
 * without the separator are returned unchanged.
 */
export function shortAgentName(name: string | null | undefined): string {
  const value = (name ?? "").trim();
  if (!value.includes(" — ")) return value;
  const tail = value.split(" — ").pop()?.trim();
  return tail || value;
}
