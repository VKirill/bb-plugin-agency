import type { SqlDatabase } from "../db/sql";
import { languageDirective } from "../i18n/language";
import { rulesForDepartment } from "../rules/work-rules";
import type { MembershipRole } from "../../shared/contracts/membership";

/**
 * Thread instructions contributed by the Agency plugin.
 *
 * Three audiences, decided from durable data only:
 * - an ordinary chat in a project bound to the Agency: route work — do it here
 *   or delegate it to the department that owns that kind of result;
 * - a department lead running an Agency job: orchestrate, never implement;
 * - an executor running an Agency job: do the job, do not re-delegate it.
 *
 * The provider sits on the thread-start path, so everything here is synchronous
 * SQLite reads and plain string assembly. BB truncates output above 4096 chars;
 * the builders cut lists themselves so the closing rules are never lost.
 */

export const DELEGATION_MODES = ["delegate", "suggest", "off"] as const;
export type DelegationMode = (typeof DELEGATION_MODES)[number];

export const INSTRUCTIONS_LIMIT = 4_000;

export type DepartmentRoute = {
  departmentId: string;
  name: string;
  purpose: string;
  leadAgentId: string;
  leadName: string;
  memberCount: number;
  /** Set for a department restricted to selected projects: the workplaces of this project it serves. */
  onlyBindingIds?: string[];
};

/** Where work of this project runs: one connected folder on one machine. */
export type Workplace = {
  bindingId: string;
  hostId: string;
  hostName?: string;
  root: string;
};

export type ProjectRoutes = {
  workplaces: Workplace[];
  departments: DepartmentRoute[];
};

/** `role` is the free-text job title; `type` is the role type in the department. */
export type WorkerMember = { agentId: string; name: string; role: string; lead: boolean; type: MembershipRole };

export type WorkerContext = {
  jobId: string;
  jobKey: string;
  title: string;
  departmentName: string;
  isLead: boolean;
  /** Role type of the assignee in the job's department; a lead-run job is `lead`. */
  assigneeType: MembershipRole;
  members: WorkerMember[];
  /** Department work rules that change how the lead and the reviewer act. */
  rules?: {
    reworkLimit: number;
    minorDefectsWithoutRound: boolean;
    reviewRequired: boolean;
    autoReview?: boolean;
    watchStallMinutes?: number;
    watchCeilingHours?: number;
    completionReminders?: number;
  };
};

export function parseDelegationMode(value: unknown): DelegationMode {
  return DELEGATION_MODES.includes(value as DelegationMode) ? (value as DelegationMode) : "delegate";
}

/** Heading of the accepted-work section in Russian and English charters. */
const ACCEPTS_HEADINGS = "Принимаем|Accepts|We accept|Accepted work";

/**
 * The «Принимаем» section of a department charter (see the agency skill
 * templates): a heading `## Принимаем` or a line `Принимаем: …`. Null when the
 * charter has no such section.
 */
export function charterAccepts(instructions: string): string | null {
  const lines = instructions.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    const inline = new RegExp(`^(?:${ACCEPTS_HEADINGS})\\s*:\\s*(.+)$`, "i").exec(line);
    if (inline) return inline[1].trim();
    if (!new RegExp(`^#{1,6}\\s*(?:${ACCEPTS_HEADINGS})\\s*:?\\s*$`, "i").test(line)) continue;
    const body: string[] = [];
    for (const next of lines.slice(index + 1)) {
      if (/^\s*#{1,6}\s/.test(next)) break;
      const item = next.trim().replace(/^[-*]\s+/, "");
      if (item) body.push(item.replace(/[.;]$/, ""));
    }
    return body.length ? body.join("; ") : null;
  }
  return null;
}

/** What the department takes: its «Принимаем» section, else the first sentence of the process. */
export function departmentPurpose(instructions: string): string {
  const accepts = charterAccepts(instructions);
  if (accepts) {
    const text = `Принимает: ${accepts}`;
    return text.length > 180 ? `${text.slice(0, 179).trimEnd()}…` : `${text}.`;
  }
  const flat = instructions.replace(/\s+/g, " ").trim();
  if (!flat) return "процесс отдела не описан";
  const sentence = /^(.+?[.!?])(\s|$)/.exec(flat)?.[1] ?? flat;
  if (sentence.length > 140) return `${sentence.slice(0, 139).trimEnd()}…`;
  return /[.!?…]$/.test(sentence) ? sentence : `${sentence}.`;
}

export function readWorkerContext(db: SqlDatabase, threadId: string): WorkerContext | null {
  const job = db
    .prepare(
      `SELECT j.id, j.key, j.title, j.assigned_agent_id, d.id AS department_id, d.name AS department_name,
              d.lead_agent_id
       FROM agency_run_attempt r
       JOIN agency_job j ON j.id = r.job_id
       JOIN agency_department d ON d.id = j.department_id
       WHERE r.thread_id = ?
       ORDER BY r.attempt_no DESC
       LIMIT 1`,
    )
    .get(threadId) as
    | {
        id: string;
        key: string;
        title: string;
        assigned_agent_id: string | null;
        department_id: string;
        department_name: string;
        lead_agent_id: string;
      }
    | undefined;
  if (!job) return null;
  const members = (
    db
      .prepare(
        `SELECT a.id AS agent_id, a.name, v.role, m.role AS membership_role
         FROM agency_membership m
         JOIN agency_agent a ON a.id = m.agent_id
         LEFT JOIN agency_agent_version v ON v.id = a.current_version_id
         WHERE m.department_id = ? AND a.state = 'active'
         ORDER BY m.role DESC, a.name`,
      )
      .all(job.department_id) as Array<{ agent_id: string; name: string; role: string | null; membership_role: string }>
  ).map((row) => ({
    agentId: row.agent_id,
    name: row.name,
    role: row.role ?? "",
    lead: row.membership_role === "lead",
    type: (row.membership_role === "lead" || row.membership_role === "reviewer" ? row.membership_role : "executor") as MembershipRole,
  }));
  const isLead = Boolean(job.assigned_agent_id) && job.assigned_agent_id === job.lead_agent_id;
  const rules = rulesForDepartment(db, job.department_id);
  const process = db
    .prepare(`SELECT pv.review_policy FROM agency_department d JOIN agency_process_version pv ON pv.id = d.process_version_id WHERE d.id = ?`)
    .get(job.department_id) as { review_policy: string } | undefined;
  let reviewRequired = true;
  try {
    reviewRequired = process ? JSON.parse(process.review_policy).required !== false : true;
  } catch {
    reviewRequired = true;
  }
  return {
    jobId: job.id,
    jobKey: job.key,
    title: job.title,
    departmentName: job.department_name,
    isLead,
    assigneeType: isLead ? "lead" : (members.find((member) => member.agentId === job.assigned_agent_id)?.type ?? "executor"),
    members,
    rules: {
      reworkLimit: rules.reworkLimit,
      minorDefectsWithoutRound: rules.minorDefectsWithoutRound,
      reviewRequired,
      autoReview: rules.autoReview,
      watchStallMinutes: rules.watchStallMinutes,
      watchCeilingHours: rules.watchCeilingHours,
      completionReminders: rules.completionReminders,
    },
  };
}

export function readProjectRoutes(
  db: SqlDatabase,
  projectId: string,
  hostName: (hostId: string) => string | undefined = () => undefined,
): ProjectRoutes {
  const bindings = db
    .prepare(
      `SELECT id, host_id, canonical_root FROM agency_project_binding
       WHERE bb_project_id = ? AND archived_at IS NULL
       ORDER BY canonical_root, id`,
    )
    .all(projectId) as Array<{ id: string; host_id: string; canonical_root: string }>;
  if (bindings.length === 0) return { workplaces: [], departments: [] };
  const ids = bindings.map((binding) => binding.id);
  const placeholders = ids.map(() => "?").join(", ");
  const rows = db
    .prepare(
      `SELECT d.id, d.name, d.lead_agent_id, d.availability, lead.name AS lead_name, pv.instructions,
              (SELECT COUNT(*) FROM agency_membership m WHERE m.department_id = d.id) AS member_count,
              (SELECT group_concat(pd.binding_id) FROM agency_project_department pd
                WHERE pd.department_id = d.id AND pd.binding_id IN (${placeholders})) AS linked
       FROM agency_department d
       JOIN agency_agent lead ON lead.id = d.lead_agent_id
       LEFT JOIN agency_process_version pv ON pv.id = d.process_version_id
       ORDER BY d.name`,
    )
    .all(...ids) as Array<{
    id: string;
    name: string;
    lead_agent_id: string;
    availability: string | null;
    lead_name: string;
    instructions: string | null;
    member_count: number;
    linked: string | null;
  }>;
  const departments: DepartmentRoute[] = [];
  for (const row of rows) {
    const selected = row.availability === "selected";
    const linked = row.linked ? row.linked.split(",").sort() : [];
    if (selected && linked.length === 0) continue;
    departments.push({
      departmentId: row.id,
      name: row.name,
      purpose: departmentPurpose(row.instructions ?? ""),
      leadAgentId: row.lead_agent_id,
      leadName: row.lead_name,
      memberCount: row.member_count,
      ...(selected && linked.length < ids.length ? { onlyBindingIds: linked } : {}),
    });
  }
  return {
    workplaces: bindings.map((binding) => ({
      bindingId: binding.id,
      hostId: binding.host_id,
      ...(hostName(binding.host_id) ? { hostName: hostName(binding.host_id) } : {}),
      root: binding.canonical_root,
    })),
    departments,
  };
}

export function countAllDepartments(db: SqlDatabase): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM agency_department`).get() as { n: number } | undefined;
  return row?.n ?? 0;
}

/** Keeps whole lines: header and rules survive, the list in between is cut with a visible marker. */
function fit(head: string[], list: string[], tail: string[], limit = INSTRUCTIONS_LIMIT): string {
  const fixed = [...head, ...tail].join("\n").length + 2;
  const kept: string[] = [];
  let used = fixed;
  for (const [index, line] of list.entries()) {
    const marker = `- …ещё ${list.length - index}: bb agency workspace --json`;
    if (used + line.length + 1 + marker.length + 1 > limit) {
      kept.push(marker);
      break;
    }
    kept.push(line);
    used += line.length + 1;
  }
  return [...head, ...kept, ...tail].join("\n").slice(0, limit);
}

/** Department rules the lead works by, in the lead's own terms. */
function leadRuleLines(rules: WorkerContext["rules"]): string[] {
  if (!rules) return [];
  return [
    `Правила отдела: не больше ${rules.reworkLimit} кругов доработки под одной задачей — дальше сервер не даст завести доработку, решение за владельцем (report-needs-input).`,
    rules.minorDefectsWithoutRound
      ? "Мелкие дефекты (уровень «мелочь») новый круг не открывают: перечислите их в итоговом отчёте и собирайте итог."
      : "Любой открытый дефект, включая мелочь, — подзадача доработки и повторная проверка.",
    rules.reviewRequired
      ? "Независимая проверка обязательна: результат каждой реализации проверяет проверяющий."
      : "Независимая проверка не обязательна: небольшую работу можно проверить самому по критерию, крупную — отдать проверяющему.",
    ...(rules.autoReview
      ? ["Автопроверка включена: после сдачи исполнителя Агентство само создаёт подзадачу проверки с приложенной версией и ставит её в очередь (комментарий «Автопроверка: создана AG-N»). Сами проверку по этой версии не создавайте — дождитесь заключения и решите по нему."]
      : []),
  ];
}

export function buildWorkerInstructions(worker: WorkerContext): string {
  if (worker.isLead) {
    const head = [
      `## Агентство: вы руководитель отдела «${worker.departmentName}» по ${worker.jobKey}`,
      `Поручение «${worker.title}» (jobId ${worker.jobId}). Ваша работа — оркестрация отдела, а не исполнение.`,
    ];
    const line = (member: WorkerMember) => `- ${member.name}${member.role ? ` — ${member.role}` : ""}: ${member.agentId}`;
    const executors = worker.members.filter((member) => member.type === "executor").map(line);
    const reviewers = worker.members.filter((member) => member.type === "reviewer").map(line);
    const list = [
      "",
      "Исполнители — реализация и доработки:",
      ...(executors.length ? executors : ["- нет: сообщите владельцу через report-needs-input"]),
      "Проверяющие — независимая проверка чужих версий:",
      ...(reviewers.length ? reviewers : ["- нет: проверяйте результат сами по критерию или попросите владельца добавить проверяющего"]),
    ];
    const tail = [
      "",
      "Порядок работы:",
      `0. Оценка на входе — первым действием: \`bb agency job comment\` с jobId ${worker.jobId}, коротким обоснованием и references intake_size (S|M|L), intake_risk (low|medium|high), intake_decision (accept|split|clarify|return). Оценка видна в карточке задачи.`,
      `1. Разбейте поручение на подзадачи с проверяемым результатом: \`bb agency job create\` c parentJobId=${worker.jobId}, departmentId отдела и assignedAgentId участника. key назначит сервер. Работа другого отдела — подзадача в том отделе на его руководителя.`,
      "   В подзадаче реализации задавайте контракт исполнения `contract`: mayChange (что можно менять), mustNotTouch (что трогать нельзя), checks (проверки перед сдачей). Он закрепляется при запуске.",
      "2. Реализацию и доработки назначайте исполнителям, проверку — проверяющим. Входы передавайте `bb agency job attach-input`; сервер не даст проверяющему получить на проверку собственную работу. Запуск — `bb agency launch readiness` → `launch prepare`.",
      "3. Когда подзадача (в том числе в другом отделе) перейдёт в review, waiting_input, blocked, done или canceled, Агентство само пришлёт сообщение в этот тред. Не опрашивайте статус циклом sleep — завершите ход и ждите.",
      "4. Проверяйте результат подзадачи по её критерию приёмки. Дефект — подзадача доработки и повторная независимая проверка, а не правка своими руками. Принимаете (`bb agency artifact accept`) только версии подзадач, которые поручили сами; сервер не даст принять свою работу.",
      ...leadRuleLines(worker.rules),
      "5. Итог — сводный отчёт .agency/jobs/<ключ главной задачи>/report.md версией артефакта и итоговый комментарий в задачу. Собственный результат не принимайте: приёмка за владельцем. Комментарии — Markdown: первая строка итог, детали списком, без лишних run_/thr_/job_ id.",
      "6. Поручение не по профилю отдела (см. «Принимаем / Не принимаем» в процессе отдела) — не берите его: `bb agency job comment` «Возврат: почему не наш профиль; какой отдел подходит», затем `bb agency job transition` в blocked. Владелец увидит задачу в «Требуют внимания».",
      "Подзадача вернулась к вам в blocked с комментарием «Возврат» — переназначьте её по роли, перенесите в подходящий отдел или отмените; зависшую попытку остановите `bb agency launch cancel`.",
    ];
    return fit(head, list, tail);
  }
  const common = [
    "- Комментарии в задачу — Markdown: первая строка — итог, детали — список (переносы `\\n` в JSON), технические id только по необходимости. Длинное — в отчёт.",
    "- Не создавайте новых поручений в Агентстве и не перепоручайте эту работу: декомпозиция — задача руководителя отдела.",
    "- Вопрос владельцу или конфликт инструкций — `bb agency job report-needs-input`, затем завершите ход.",
    "- Сдача — это версия и итоговый комментарий. Без итогового комментария после публикации задача не уйдёт на проверку.",
    `- Завершили ход без опубликованной версии или без итогового комментария — Агентство пришлёт напоминание; после ${worker.rules?.completionReminders ?? 2} напоминаний задача уйдёт руководителю как заблокированная.`,
    `- Агентство следит за попыткой: ${worker.rules?.watchStallMinutes ?? 30} мин без новых событий или ${worker.rules?.watchCeilingHours ?? 2} ч непрерывной работы — задача уйдёт руководителю как заблокированная. Долгую работу делите на этапы и отмечайте их комментариями.`,
    "- В поручении есть контракт исполнения — работайте в его границах: «Нельзя трогать» не меняйте, все «Проверки» пройдите и перечислите в итоговом комментарии. Нужно выйти за границу — вопрос руководителю комментарием, не решение.",
  ];
  if (worker.assigneeType === "reviewer") {
    return [
      `## Агентство: вы проверяющий ${worker.jobKey}`,
      `Тред запущен Агентством для поручения «${worker.title}» отдела «${worker.departmentName}». Ваша работа — независимая проверка чужой версии, а не её исправление.`,
      "- Проверяйте входные версии этого поручения (`bb agency job get` → inputs, затем `bb agency artifact open` с hash), а не рабочие файлы на слово. Нет входной версии или критерия — возврат руководителю.",
      "- Проверяемый результат не правьте: дефекты описывайте (критерий → место → как воспроизвести → серьёзность: блокирует / важно / мелочь), исправит исполнитель.",
      ...(worker.rules?.minorDefectsWithoutRound ? ["- В этом отделе мелочи не открывают новый круг: вердикт «принять с замечаниями», если остались только дефекты уровня «мелочь»."] : []),
      "- Поручение оказалось проверкой вашей собственной работы или реализацией — не берите: `bb agency job comment` «Возврат: причина», затем `bb agency job transition` в blocked и завершите ход.",
      "- Сдача: заключение .agency/jobs/<ключ>/report.md (вердикт, таблица критериев, дефекты, команды и вывод) → `bb agency artifact create` и `artifact publish` → итоговый `bb agency job comment` с вердиктом → завершить ход. Результат не принимайте: решение за руководителем или владельцем.",
      ...common,
    ].join("\n");
  }
  return [
    `## Агентство: вы исполнитель ${worker.jobKey}`,
    `Тред запущен Агентством для поручения «${worker.title}» отдела «${worker.departmentName}». Выполняйте работу сами в границах брифа.`,
    "- Сначала сверьте поручение со своей должностной инструкцией. Не ваш пул работ или нет обязательных входов — не начинайте: `bb agency job comment` «Возврат: причина; кому подходит; чего не хватает», затем `bb agency job transition` в blocked и завершите ход. Руководитель получит сообщение.",
    "- Сдача работы: отчёт .agency/jobs/<ключ>/report.md (итог, что сделано и где, чем проверено, что не сделано) → `bb agency artifact create` и `artifact publish` → итоговый `bb agency job comment` для руководителя со ссылкой на версию → завершить ход. Слово «готово» в ответе не является приёмкой.",
    ...common,
  ].join("\n");
}

export function buildSessionInstructions(input: {
  mode: Exclude<DelegationMode, "off">;
  routes: ProjectRoutes;
  totalDepartments: number;
}): string | null {
  const { workplaces, departments } = input.routes;
  if (workplaces.length === 0 || departments.length === 0) {
    if (input.totalDepartments === 0) return null;
    return [
      "## Агентство",
      `В BB есть Агентство — отделы агентов с руководителями (${input.totalDepartments}). ${workplaces.length === 0 ? "Этот проект к нему не подключён." : "Для этого проекта нет доступных отделов."}`,
      "Если владелец просит поручить крупную работу команде — скажи, что проект нужно подключить в Агентстве (раздел «Проекты»). Сам поручение не создавай.",
    ].join("\n");
  }
  const suggest = input.mode === "suggest";
  const single = workplaces.length === 1 ? workplaces[0] : null;
  const head = [
    "## Агентство: куда направить работу",
    "В BB работает Агентство — постоянные отделы агентов с руководителем, очередью задач и приёмкой результата. Отделы общие: принимают задачи из любого подключённого проекта. Перед работой выбери маршрут:",
    "- Сделай сам в этом треде: ответ или объяснение, разовая команда, небольшая правка, срочное, настройка самого BB или Агентства.",
    `- ${suggest ? "Предложи поручить" : "Поручи"} Агентству: многошаговая работа с отдельным результатом (код, текст, исследование, аудит), нужна независимая проверка, работа переживёт этот чат, или владелец просит «поручи/делегируй».`,
    "- Не уверен — назови владельцу маршрут одной фразой и дождись ответа.",
    "- Ты дочерний тред или субагент, которому уже поручили часть работы, — выполняй её, не перепоручай.",
    "",
    single
      ? `Работа этого проекта выполняется на машине ${single.hostName ?? single.hostId} в папке ${single.root} (bindingId ${single.bindingId}).`
      : "Где выполняется работа — выбери место, где лежит папка твоего окружения (сравни с pwd); сотрудник запустится на этой машине:",
    ...(single
      ? []
      : workplaces.map((place) => `- ${place.bindingId}: ${place.hostName ?? place.hostId} — ${place.root}`)),
    "",
    "Отделы — выбирай по сути результата, не по модели:",
  ];
  const list = departments.map(
    (department) =>
      `- «${department.name}» — ${department.purpose} Руководитель: ${department.leadName} (${department.leadAgentId}); сотрудников: ${department.memberCount}; departmentId ${department.departmentId}${department.onlyBindingIds ? `; только для ${department.onlyBindingIds.join(", ")}` : ""}`,
  );
  const bindingId = single ? single.bindingId : "<bindingId рабочего места>";
  const tail = [
    "Подходящего отдела нет — не создавай поручение, скажи владельцу, какого отдела не хватает.",
    "",
    suggest ? "Как поручить после согласия владельца:" : "Как поручить:",
    `\`bb agency job create --input-json '{"requestId":"<новый UUID>","bindingId":"${bindingId}","departmentId":"…","assignedAgentId":"<руководитель отдела>","title":"…","brief":"…","acceptance":"…"}'\``,
    "- key назначит сервер. brief: цель, входы, границы (что не трогать). acceptance: проверяемый критерий результата.",
    "- Назначай руководителю отдела: он декомпозирует и раздаёт подзадачи. Исполнителей в обход него не назначай.",
    "- После создания сообщи владельцу ключ AG-N и следующий шаг. Поручённую работу сам не выполняй; запуск не объявляй без квитанции `bb agency launch prepare`.",
    "- Создать отдел или сотрудника, написать должностную инструкцию — по навыку `agency`.",
  ];
  return fit(head, list, tail);
}

function withLanguage(text: string | null): string | null {
  return text ? `${text}\n${languageDirective()}` : text;
}

export function buildAgencyInstructions(
  db: SqlDatabase,
  ctx: { threadId: string; projectId: string },
  mode: DelegationMode,
  hostName?: (hostId: string) => string | undefined,
): string | null {
  if (mode === "off") return null;
  const worker = readWorkerContext(db, ctx.threadId);
  if (worker) return withLanguage(buildWorkerInstructions(worker));
  return buildSessionInstructions({
    mode,
    routes: readProjectRoutes(db, ctx.projectId, hostName),
    totalDepartments: countAllDepartments(db),
  });
}
