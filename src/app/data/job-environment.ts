/**
 * Runtime facts the task card shows in the "Среда запуска" rail card.
 *
 * `isolationReady` is null while the server has not answered; `attempts` is
 * null when the attempt list could not be read. Both stay unknown rather than
 * defaulting to a reassuring value.
 */
export type JobEnvironmentStatus = {
  isolationReady: boolean | null;
  attempts: number | null;
};

export const JOB_ENVIRONMENT_UNKNOWN: JobEnvironmentStatus = { isolationReady: null, attempts: null };

export const ISOLATION_CONFIRMED = "Подтверждена";
export const ISOLATION_UNCONFIRMED = "Не подтверждена";
export const ISOLATION_UNKNOWN = "Проверяем";
export const HOST_UNKNOWN = "не определён";

export function jobEnvironmentEqual(a: JobEnvironmentStatus, b: JobEnvironmentStatus): boolean {
  return a.isolationReady === b.isolationReady && a.attempts === b.attempts;
}

export function isolationLabel(status: JobEnvironmentStatus): { text: string; tone: "success" | "muted" | "default" } {
  if (status.isolationReady === null) return { text: ISOLATION_UNKNOWN, tone: "muted" };
  if (status.isolationReady) return { text: ISOLATION_CONFIRMED, tone: "success" };
  return { text: ISOLATION_UNCONFIRMED, tone: "default" };
}

export function attemptsLabel(status: JobEnvironmentStatus): string {
  return status.attempts === null ? "—" : String(status.attempts);
}

/** Host of the project binding the job is placed in, as shown in the rail. */
export function jobHostLabel(
  bindingId: string | undefined,
  projects: readonly { id: string; hostName?: string | null }[],
): string {
  const host = projects.find((item) => item.id === bindingId)?.hostName?.trim();
  return host || HOST_UNKNOWN;
}
