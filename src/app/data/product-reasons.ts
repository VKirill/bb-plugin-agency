import { tr } from "../i18n";

/** Product copy for server codes/reasons. Technical text stays behind `technicalServerReason`. */

export const PRODUCT_ASSIGNEE_REQUIRED = "Сначала назначьте исполнителя из состава этого отдела.";
export const PRODUCT_HANDSHAKE_UNREADY =
  "Среда ещё не подтвердила изолированный запуск.";
export const PRODUCT_LAUNCH_UNAVAILABLE = "Сейчас запуск недоступен.";
export const PRODUCT_LAUNCH_READY = "Готово к запуску";
export const PRODUCT_LAUNCH_STARTED = "Запуск начат";
export const PRODUCT_LAUNCH_REFUSED = "Запуск отклонён.";
export const PRODUCT_PUBLICATION_VERIFIED = "Файл опубликован; результат ожидает приёмки";

const CODE_PRODUCT: Record<string, string> = {
  assignee_required: PRODUCT_ASSIGNEE_REQUIRED,
  assignee_not_member:
    "Исполнитель должен состоять в выбранном отделе. Выберите сотрудника из состава отдела.",
  handshake_unready: PRODUCT_HANDSHAKE_UNREADY,
  launch_not_authorized: PRODUCT_LAUNCH_UNAVAILABLE,
  provider_not_allowed_by_policy: "Политика прав сотрудника не разрешает выбранный CLI. Выберите политику, которая разрешает этот CLI или любой CLI.",
  provider_unavailable: "Выбранный CLI не подключён в BB на машине проекта. Подключите его в настройках BB или выберите сотруднику другой CLI.",
  agent_inactive: "Сотрудник приостановлен. Включите его профиль или назначьте другого исполнителя.",
  assignee_is_reviewer: "Исполнитель не может быть проверяющим своей же задачи. Назначьте проверяющим другого сотрудника.",
  job_has_live_run: "Тред сотрудника ещё работает. Сначала остановите запуск в карточке задачи.",
  member_has_open_jobs: "У сотрудника есть открытые задачи в этом отделе. Переназначьте или закройте их, затем меняйте состав.",
  self_review: "Проверяющий не может проверять работу, которую сделал сам. Назначьте другого проверяющего.",
  rework_no_thread: "У задачи нет треда, который ждёт проверки. Поставьте задачу в очередь и запустите заново.",
  rework_no_version: "У задачи нет опубликованной версии результата, возвращать нечего.",
  rework_send_rejected: "Не удалось отправить замечания исполнителю. Задача осталась на проверке, попробуйте ещё раз.",
  rework_send_unknown: "Не удалось подтвердить, что замечания дошли. Нажмите «Вернуть на доработку» ещё раз — повтор не продублирует сообщение.",
  missing_transition_guard: "Для этого шага не хватает условий: исполнитель, проект, бриф и критерии приёмки, а для проверки — опубликованная версия.",
  open_blockers: "Задача зависит от незавершённых задач. Сначала закройте их.",
  policy_effective_empty: "Права проекта и сотрудника не пересекаются: у них нет общего разрешения. Проверьте политику сотрудника и проекта.",
  provider_constraint_mismatch: "Политика проекта или сотрудника не разрешает CLI сотрудника. В карточке проекта нажмите «Разрешить любой CLI» или сохраните профиль сотрудника с этим CLI ещё раз.",
  host_constraint_mismatch: "Политика сотрудника не разрешает машину этого проекта. Проверьте политику.",
  unknown_skill: "Навык сотрудника не найден на машине проекта. Уберите его из профиля или установите навык на этой машине.",
  unknown_mcp: "MCP из профиля сотрудника пока не передаются в запуск. Уберите MCP из профиля.",
  catalog_host_mismatch: "Машина проекта не входит в настройки навыков Агентства. Добавьте её в «Настройки плагина → Isolated catalog roles».",
  catalog_skill_hash_mismatch: "Навык Агентства на сервере изменился, а закреплённый хэш старый. Обновите хэш навыка в настройках плагина.",
  catalog_role_unresolved: "На машине проекта не найден навык Агентства. Проверьте, что плагин установлен и навыки видны в BB.",
  project_rules_missing: "В папке проекта нет файла правил .bb/AGENTS.md. Создайте его во вкладке «Правила» проекта.",
  binding_archived: "Проект отключён от Агентства: запуски в нём недоступны. Верните проект в его карточке.",
  brief_required: "Заполните «Что нужно сделать» и «Критерии приёмки».",
  rework_limit_reached: "Лимит кругов доработки исчерпан. Решите сами: принять с замечаниями, отменить или поднять лимит в правилах отдела.",
  rule_not_in_scope: "Эту настройку нельзя задать на этом уровне.",
  job_closed: "Задача закрыта: новые версии и файлы в неё не добавляются. Для доработки создайте новую задачу.",
  illegal_job_state: "Запустить можно задачу из бэклога или очереди. Задачу из «Ожидает решения» сначала верните в очередь.",
  host_mismatch: "Машина проекта не совпадает с окружением запуска. Проверьте подключение проекта.",
  policy_mismatch: "Политика прав изменилась после подготовки запуска. Запустите задачу ещё раз.",
  version_mismatch: "Профиль сотрудника или регламент отдела изменились. Запустите задачу ещё раз.",
  process_mismatch: "Регламент отдела изменился после подготовки запуска. Запустите задачу ещё раз.",
  project_rules_hash_mismatch: "Правила проекта изменились во время подготовки запуска. Запустите задачу ещё раз.",
  secret_grant_mismatch: "Политики проекта и сотрудника разрешают разные секреты. Проверьте политику.",
  duplicate_department_name: "Отдел с таким названием уже есть. Названия отделов должны различаться: по ним агенты выбирают, куда поручить работу.",
};

export function productFromReasonCode(code: string | null | undefined): string | null {
  if (!code?.trim()) return null;
  if (code === "ok") return tr(PRODUCT_LAUNCH_READY);
  const text = CODE_PRODUCT[code];
  return text ? tr(text) : null;
}

/** Codes first; English `reason` is fallback / technical. `ok` is ready, not unavailable. */
export function productLaunchCopy(input: {
  reasonCode?: string | null;
  reason?: string | null;
}): string {
  if (input.reasonCode === "ok") return tr(PRODUCT_LAUNCH_READY);
  // A specific reason already written for people (machine offline, no rules file) beats the generic «недоступен».
  if (input.reasonCode === "launch_not_authorized" && input.reason && /[А-Яа-яЁё]/.test(input.reason) && !looksTechnicalReason(input.reason)) {
    return input.reason;
  }
  return productFromReasonCode(input.reasonCode) ?? productServerReason(input.reason);
}

const REASON_PRODUCT: { match: RegExp; text: string }[] = [
  { match: /assignedAgentId is required/i, text: PRODUCT_ASSIGNEE_REQUIRED },
  { match: /assignee_required/i, text: PRODUCT_ASSIGNEE_REQUIRED },
  {
    match: /experimental_thread-spawn-contract|GET\s+\/api\/v1\/system/i,
    text: PRODUCT_HANDSHAKE_UNREADY,
  },
  {
    match: /typed runtime capability|instance names are not evidence|Engines|SDK 0\.4|ordinary SDK/i,
    text: PRODUCT_HANDSHAKE_UNREADY,
  },
  {
    match: /Isolation and isolated spawn fields are not proven/i,
    text: PRODUCT_HANDSHAKE_UNREADY,
  },
  { match: /verified bind applied/i, text: PRODUCT_LAUNCH_STARTED },
];

export function productInterpretNotice(view: {
  publishedVerified?: boolean;
  mayEnterReview?: boolean;
  runFailed?: boolean;
  reason: string;
}): string {
  if (view.runFailed) return productServerReason(view.reason);
  if (view.publishedVerified || view.mayEnterReview) return tr(PRODUCT_PUBLICATION_VERIFIED);
  return productServerReason(view.reason);
}

export function productPrepareLaunchNotice(view: {
  handshakeReady: boolean;
  launched: { kind: string } | null;
  reasonCode?: string | null;
  reason: string;
}): string {
  if (view.launched?.kind === "running" || /verified bind applied/i.test(view.reason)) {
    return tr(PRODUCT_LAUNCH_STARTED);
  }
  if (!view.handshakeReady || view.launched?.kind === "failed") {
    // Compare the reason code, not the (possibly already translated) copy text.
    if (view.reasonCode === "ok") return tr(PRODUCT_LAUNCH_REFUSED);
    return productLaunchCopy({ reasonCode: view.reasonCode, reason: view.reason });
  }
  return productLaunchCopy({ reasonCode: view.reasonCode, reason: view.reason });
}


export function looksTechnicalReason(raw: string): boolean {
  return /\/api\/|assignedAgentId|spawn-contract|TypeScript|SDK|Engines|ThreadSpawnArgs|handshake protocol|fingerprint confirms/i.test(
    raw,
  );
}

export function productServerReason(raw: string | null | undefined): string {
  if (!raw?.trim()) return tr(PRODUCT_LAUNCH_UNAVAILABLE);
  for (const row of REASON_PRODUCT) {
    if (row.match.test(raw)) return tr(row.text);
  }
  if (looksTechnicalReason(raw)) return tr(PRODUCT_LAUNCH_UNAVAILABLE);
  // Not a technical string: it may be one of our own fixed Russian messages
  // (dictionary hit) or department/server-authored text (no match, passes through).
  return tr(raw);
}

export function productDomainNotice(code: string, message: string): string {
  const text = CODE_PRODUCT[code];
  return text ? tr(text) : productServerReason(message);
}

export function technicalServerReason(raw: string | null | undefined): string | null {
  if (!raw?.trim()) return null;
  if (productServerReason(raw) === raw) return null;
  return raw;
}

export function technicalLaunchReason(input: {
  reasonCode?: string | null;
  reason?: string | null;
}): string | null {
  const raw = input.reason?.trim();
  if (!raw) return null;
  if (productLaunchCopy(input) === raw) return null;
  return raw;
}
