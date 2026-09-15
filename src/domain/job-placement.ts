import { fail, ok, type DomainResult } from "./result";

const ACTIVE_RUN_STATES = new Set(["queued", "running", "waiting_input"]);

export function effectiveAssignedAgentId(
  currentAssignedAgentId: string | null,
  patchAssignedAgentId: string | null | undefined,
): string | null {
  return patchAssignedAgentId === undefined ? currentAssignedAgentId : patchAssignedAgentId;
}

export function assertAssigneeInDepartment(
  departmentId: string,
  assignedAgentId: string | null,
  isMember: boolean,
): DomainResult<string | null> {
  if (!assignedAgentId) return ok(null);
  if (!isMember) {
    return fail(
      "assignee_not_member",
      "Исполнитель должен состоять в новом отделе. Смените исполнителя или состав отдела до сохранения.",
    );
  }
  return ok(assignedAgentId);
}

export function isActiveRunState(state: string, threadBound: boolean): boolean {
  return threadBound || ACTIVE_RUN_STATES.has(state);
}

export function assertBindingMoveAllowed(input: {
  moving: boolean;
  isChild: boolean;
  hasChildren: boolean;
  hasDependencies: boolean;
  hasArtifacts: boolean;
  hasRun: boolean;
}): DomainResult<true> {
  if (!input.moving) return ok(true);
  if (input.isChild) {
    return fail("binding_move_blocked", "Подзадачу нельзя перенести в другой проект отдельно от родителя.");
  }
  if (input.hasChildren) {
    return fail(
      "job_has_children",
      "У задачи есть подзадачи в этом проекте. Перенос без миграции оставит их в старом проекте.",
    );
  }
  if (input.hasDependencies) {
    return fail(
      "job_has_dependencies",
      "У задачи есть зависимости в этом проекте. Перенос разорвёт связи.",
    );
  }
  if (input.hasArtifacts) {
    return fail(
      "job_has_artifacts",
      "У задачи есть файлы в корне текущего проекта. Перенос не копирует файлы молча.",
    );
  }
  if (input.hasRun) {
    return fail(
      "job_has_run",
      "Задача в работе или привязана к запуску. Сначала завершите или отмените запуск.",
    );
  }
  return ok(true);
}
