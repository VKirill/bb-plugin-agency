import { tr } from "../i18n";
import type { Job, State, TaskFile } from "../prototype/data";
import { isOpaqueRecordId } from "./content-hash";

export const WAITING_INPUT_STATUS_NOTICE =
  "Исполнитель ждёт ответа на вопрос: ответьте в карточке задачи, статус изменится сам.";

export const KANBAN_ACTIVE_NOTICE =
  "Этот переход не делается перетаскиванием. Нужны проверка результата, приёмка версии или ответ на вопрос.";

export const ACCEPT_THEN_DONE_NOTICE =
  "«Готово» ставится приёмкой результата: откройте задачу на проверке и нажмите «Принять результат».";

export const ACCEPT_NO_TARGET_NOTICE =
  "Выберите версию результата, которую принимаете.";

export const ACCEPT_AMBIGUOUS_NOTICE =
  "У задачи несколько версий результата. Выберите, какую принимаете.";

export const ACCEPT_STALE_SELECTION_NOTICE =
  "Пока вы выбирали, появилась новая версия результата. Выберите версию заново.";

export const INTERPRET_WAITING_NOTICE =
  "Пока задача ждёт ввода, проверка результата закрыта.";

export const JOB_CANCELED_LABEL = "Задача отменена";
export const LAST_LAUNCH_UNACCEPTED = "Последний запуск не принят";
export const INTERPRET_PUBLICATION_LABEL = "Сверить публикацию";

export function jobIsCanceled(job: { state?: string | null; sourceState?: string | null; jobState?: string | null }): boolean {
  return job.state === "canceled" || job.sourceState === "canceled" || job.jobState === "canceled";
}

const CONTENT_HASH = /^[a-f0-9]{64}$/i;

export type ProvenAcceptTarget = {
  artifactId: string;
  version: number;
  hash: string;
};

export function jobLifecycleLocked(
  job: Pick<Job, "state" | "sourceState">,
  needsInput = false,
): boolean {
  return needsInput || job.sourceState === "waiting_input" || job.state === "waiting_input";
}

export function interpretCompletionLocked(input: {
  jobState?: string | null;
  sourceState?: string | null;
  attemptState?: string | null;
  needsInput?: boolean;
}): boolean {
  return (
    input.needsInput === true ||
    input.sourceState === "waiting_input" ||
    input.jobState === "waiting_input" ||
    input.attemptState === "waiting_input" ||
    jobIsCanceled(input)
  );
}

export function interpretButtonDisabled(input: {
  pending: boolean;
  launchId?: string | null;
  jobState?: string | null;
  sourceState?: string | null;
  attemptState?: string | null;
  needsInput?: boolean;
}): boolean {
  return input.pending || !input.launchId || interpretCompletionLocked(input);
}

/**
 * Statuses the owner may set by hand. Work states come from the work itself:
 * «В работе» from a launch, «На проверке» from a published version, «Готово»
 * from acceptance, «Ждёт ответа» from the worker's question. A running job is
 * stopped from its card, not by picking «Отменено».
 */
export const MANUAL_STATUS_TARGETS: Readonly<Record<State, readonly State[]>> = {
  backlog: ["queued", "canceled"],
  queued: ["canceled"],
  blocked: ["queued", "canceled"],
  running: [],
  waiting_input: [],
  review: ["canceled"],
  done: [],
  canceled: [],
};

export const WORK_STATE_NOTICE =
  "«В работе», «На проверке», «Готово» и «Ждёт ответа» ставит сама работа: запуск, сдача версии, приёмка и вопрос исполнителя.";

export const STOP_RUN_FIRST_NOTICE =
  "Задача в работе: сначала остановите запуск в карточке задачи, затем решайте, что с ней делать.";

export function manualStatusOptions(state: State): State[] {
  return [state, ...MANUAL_STATUS_TARGETS[state]];
}

function manualStatusRefusal(job: Pick<Job, "state" | "sourceState">, to: State, needsInput: boolean): string | null {
  if (job.state === to) return null;
  if (jobLifecycleLocked(job, needsInput)) return tr(WAITING_INPUT_STATUS_NOTICE);
  if (to === "done") return tr(ACCEPT_THEN_DONE_NOTICE);
  if (MANUAL_STATUS_TARGETS[job.state].includes(to)) return null;
  if (job.state === "running") return tr(STOP_RUN_FIRST_NOTICE);
  return tr(WORK_STATE_NOTICE);
}

export function jobKanbanMoveRefusal(
  job: Pick<Job, "state" | "sourceState">,
  to: State,
  needsInput = false,
): string | null {
  return manualStatusRefusal(job, to, needsInput);
}

export function jobPersistStatusRefusal(
  job: Pick<Job, "state" | "sourceState">,
  to: State,
  needsInput = false,
): string | null {
  return manualStatusRefusal(job, to, needsInput);
}

export function provenAcceptFiles(files: readonly TaskFile[]): TaskFile[] {
  return files.filter((file) => Boolean(fileToAcceptTarget(file)));
}

export function fileToAcceptTarget(file: TaskFile): ProvenAcceptTarget | null {
  if (!isOpaqueRecordId(file.id) || !file.version || file.version < 1 || !file.hash || !CONTENT_HASH.test(file.hash)) {
    return null;
  }
  return { artifactId: file.id, version: file.version, hash: file.hash };
}

export function acceptSelectionKey(target: ProvenAcceptTarget): string {
  return `${target.artifactId}:${target.version}:${target.hash}`;
}

export function parseAcceptSelectionKey(value: string | null | undefined): ProvenAcceptTarget | null {
  if (!value || value === "none") return null;
  const [artifactId, versionRaw, hash] = value.split(":");
  const version = Number(versionRaw);
  if (!artifactId || !hash || !Number.isInteger(version) || version < 1 || !CONTENT_HASH.test(hash)) return null;
  if (!isOpaqueRecordId(artifactId)) return null;
  return { artifactId, version, hash };
}

export function acceptSelectionStillLive(files: readonly TaskFile[], key: string | null | undefined): boolean {
  const parsed = parseAcceptSelectionKey(key);
  if (!parsed) return false;
  return provenAcceptFiles(files).some((file) => {
    const target = fileToAcceptTarget(file);
    return Boolean(target && acceptSelectionKey(target) === key);
  });
}

/** Explicit artifactId+version+hash. Artifact id alone is not a target. */
export function resolveAcceptTarget(
  files: readonly TaskFile[],
  selectedKey: string | null | undefined,
): { ok: true; target: ProvenAcceptTarget } | { ok: false; reason: string } {
  const proven = provenAcceptFiles(files);
  const parsed = parseAcceptSelectionKey(selectedKey);
  if (!parsed) {
    return { ok: false, reason: tr(proven.length > 1 ? ACCEPT_AMBIGUOUS_NOTICE : ACCEPT_NO_TARGET_NOTICE) };
  }
  const live = proven.find((file) => {
    const target = fileToAcceptTarget(file);
    return Boolean(target && acceptSelectionKey(target) === acceptSelectionKey(parsed));
  });
  if (!live) return { ok: false, reason: tr(ACCEPT_STALE_SELECTION_NOTICE) };
  return { ok: true, target: parsed };
}

export function activityRoleLabel(author?: string, role?: string): string | undefined {
  if (!role || role === author) return undefined;
  return role;
}
