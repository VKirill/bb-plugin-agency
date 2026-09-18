/**
 * Чей это проект. Владелец зовёт RPC из интерфейса без треда и видит всё Агентство; сотрудник
 * зовёт из треда своей попытки и работает в одном проекте.
 *
 * `allowedBindingIds` для этого не годится: там лежат все привязки Агентства, потому что доступ
 * к самой базе один на установку. Проверка идёт по задаче вызывающего.
 */

export type ProjectCaller = { jobId: string } | null | undefined;

export function projectAccessAllowed(
  caller: ProjectCaller,
  bbProjectId: string | undefined,
  projectOfJob: (jobId: string) => string | null,
): boolean {
  // Владелец, или запрос без проекта: сужать нечего.
  if (!caller || !bbProjectId) return true;
  return projectOfJob(caller.jobId) === bbProjectId;
}
