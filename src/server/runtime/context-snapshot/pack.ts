import { sha256Hex } from "./canonical.js";

/**
 * The attempt pack: what an employee reads before the work, as files next to the job's report.
 * It is cut from the same records as the prompt levels and its file hashes go into the snapshot,
 * so the digest answers for what lies on disk. The database stays the truth; the pack is a cast.
 */

export type PackLanguage = "ru" | "en";

export type AttemptPackFile = { name: string; body: string };

export type SnapshotPack = {
  /** Folder of the pack, relative to the binding root. */
  dir: string;
  /** Membership role the CLI card was cut for; absent when the assignee has no membership. */
  role?: string;
  files: { name: string; hash: string }[];
};

export const PACK_ENTRY = "TASK.md";
/** Every name the pack may write: a file of this list that the new pack lacks is stale and goes away. */
export const PACK_FILE_NAMES = [PACK_ENTRY, "contract.md", "inputs.md", "handoff.md", "briefing.md", "rules.md", "project.md", "cli.md"] as const;

export function attemptPackDir(jobKey: string): string {
  return `.agency/jobs/${jobKey}`;
}

export type AttemptPackInput = {
  job: { id: string; key: string; title: string; brief: string; acceptance: string };
  /** Membership role in the job's department: lead, executor, reviewer, assistant. */
  memberRole: string | null;
  /** Free-text job title of the employee. */
  position: string;
  lang: PackLanguage;
  contract: string;
  /** Input versions and extra folders, one line each; empty when the job has none. */
  inputLines: readonly string[];
  /** Compiled handoff of the previous attempt; null on a first attempt. */
  handoff: string | null;
  briefing: string | null;
  /** Agency rules, role guidance, department process, employee instructions, skills of the launch. */
  rules: readonly string[];
  /** Passport, accepted knowledge, work profile; empty when the project has none. */
  project: readonly string[];
};

const COPY = {
  ru: {
    role: { lead: "руководитель", executor: "исполнитель", reviewer: "проверяющий", assistant: "помощник" } as Record<string, string>,
    roleLine: (role: string, position: string) => `Роль в этой задаче: ${role}${position ? ` (${position})` : ""}.`,
    todo: "Что сделать",
    acceptance: "Приёмка",
    emptyBrief: "(пустой бриф)",
    emptyAcceptance: "(пустой критерий)",
    pack: "Пакет",
    packIntro: "Файлы рядом с этим. Прочитайте их до первой правки.",
    files: {
      "contract.md": "границы работы: что можно менять, что нельзя, проверки перед сдачей",
      "inputs.md": "входные версии и папки",
      "handoff.md": "передача с предыдущей попытки",
      "briefing.md": "подсказка оценщика: какие навыки и записи памяти здесь нужны; не приказ",
      "rules.md": "правила агентства, регламент отдела, должностная инструкция, навыки запуска",
      "project.md": "паспорт проекта, принятые знания, профиль работы",
      "cli.md": "команды Агентства для этой роли",
    } as Record<string, string>,
    finish: "Как сдать",
    finishLines: (key: string) => [
      `- Отчёт \`${attemptPackDir(key)}/report.md\`.`,
      "- `bb agency artifact create`, затем `artifact publish` (см. `cli.md`).",
      "- Итоговый `bb agency job comment` и конец хода.",
      "- Свой результат не принимай. Станцию закрывает конвейер.",
      "- `report-needs-input` только если не хватает сырья: секреты, деньги, необратимое действие владельца.",
    ],
    truth: "Правда в базе Агентства; этот пакет — слепок снимка на момент запуска.",
    contract: "Контракт исполнения",
    contractIntro: "Граница этой работы. Выход за неё — вопрос руководителю, не собственное решение.",
    inputs: "Входы",
    handoff: "Передача с предыдущей попытки",
    briefing: "Подсказка",
    rules: "Правила и инструкции",
    project: "Проект",
    cli: "CLI этой роли",
    cliIntro: "Все команды принимают `--input-json '<payload>'`; поля: `bb agency schema <operation>`. `requestId` — новый UUID на каждую команду.",
    cliSpare: "`bb agency job get` и `bb agency knowledge get` — запасной канал, когда пакета не хватило; задание уже здесь.",
    verdict: "Первая строка отчёта И итогового комментария задачи: `Вердикт: принять` или `Вердикт: доработать`.",
  },
  en: {
    role: { lead: "lead", executor: "executor", reviewer: "reviewer", assistant: "assistant" } as Record<string, string>,
    roleLine: (role: string, position: string) => `Role in this job: ${role}${position ? ` (${position})` : ""}.`,
    todo: "What to do",
    acceptance: "Acceptance",
    emptyBrief: "(empty brief)",
    emptyAcceptance: "(empty acceptance)",
    pack: "Pack",
    packIntro: "Files next to this one. Read them before the first edit.",
    files: {
      "contract.md": "the boundary of the work: what may change, what may not, checks before hand-in",
      "inputs.md": "input versions and folders",
      "handoff.md": "handoff from the previous attempt",
      "briefing.md": "the evaluator's hint: skills and memory records needed here; not an order",
      "rules.md": "agency rules, department process, employee instructions, skills of this launch",
      "project.md": "project passport, accepted knowledge, work profile",
      "cli.md": "Agency commands for this role",
    } as Record<string, string>,
    finish: "How to finish",
    finishLines: (key: string) => [
      `- Write the report at \`${attemptPackDir(key)}/report.md\`.`,
      "- `bb agency artifact create` then `artifact publish` (see `cli.md`).",
      "- Leave a closing `bb agency job comment` and end the turn.",
      "- Do not accept your own result. The conveyor closes the station.",
      "- `report-needs-input` only for missing materials: secrets, money, irreversible owner action.",
    ],
    truth: "The Agency database is the truth; this pack is a cast of the snapshot at launch.",
    contract: "Execution contract",
    contractIntro: "The boundary of this work. Going outside it is a question to the lead, not a decision.",
    inputs: "Inputs",
    handoff: "Handoff from the previous attempt",
    briefing: "Briefing",
    rules: "Rules and instructions",
    project: "Project",
    cli: "CLI for this role",
    cliIntro: "Every command takes `--input-json '<payload>'`; fields: `bb agency schema <operation>`. `requestId` is a fresh UUID per command.",
    cliSpare: "`bb agency job get` and `bb agency knowledge get` are the spare channel for when the pack falls short; the assignment is already here.",
    verdict: "First line of the report AND of the closing job comment: `Verdict: accept` or `Verdict: rework`.",
  },
} as const;

/** Commands of the role card, by membership role. An unknown role gets the narrowest card. */
export function roleCliCommands(memberRole: string | null): string[] {
  const hand = ["bb agency job comment", "bb agency artifact create", "bb agency artifact publish"];
  if (memberRole === "lead") {
    return [...hand, "bb agency job report-needs-input", "bb agency job return", "bb agency job create", "bb agency job attach-input"];
  }
  // `job return` sends a closed product back for rework: a lead's call, not an executor's.
  if (memberRole === "executor") return [...hand, "bb agency job report-needs-input"];
  // A reviewer hands in a verdict; an assistant hands in a version. Neither creates, accepts or asks the owner.
  return hand;
}

function cliCard(input: AttemptPackInput): string {
  const copy = COPY[input.lang];
  const payload: Record<string, string> = {
    "bb agency job comment": `--input-json '{"requestId":"<uuid>","jobId":"${input.job.id}","comment":"..."}'`,
    "bb agency artifact create": `--input-json '{"requestId":"<uuid>","jobId":"${input.job.id}"}'`,
  };
  return [
    `# ${copy.cli}`,
    "",
    copy.cliIntro,
    "",
    ...roleCliCommands(input.memberRole).map((command) => `- \`${command}${payload[command] ? ` ${payload[command]}` : ""}\``),
    ...(input.memberRole === "reviewer" ? ["", copy.verdict] : []),
    "",
    copy.cliSpare,
  ].join("\n");
}

function section(title: string, lines: readonly string[]): string {
  return [`# ${title}`, "", ...lines].join("\n");
}

export function buildAttemptPack(input: AttemptPackInput): AttemptPackFile[] {
  const copy = COPY[input.lang];
  const optional: AttemptPackFile[] = [
    ...(input.contract.trim() ? [{ name: "contract.md", body: section(copy.contract, [copy.contractIntro, "", input.contract.trim()]) }] : []),
    ...(input.inputLines.length ? [{ name: "inputs.md", body: section(copy.inputs, input.inputLines) }] : []),
    ...(input.handoff?.trim() ? [{ name: "handoff.md", body: section(copy.handoff, [input.handoff.trim()]) }] : []),
    ...(input.briefing?.trim() ? [{ name: "briefing.md", body: section(copy.briefing, [input.briefing.trim()]) }] : []),
    ...(input.rules.length ? [{ name: "rules.md", body: section(copy.rules, input.rules) }] : []),
    ...(input.project.length ? [{ name: "project.md", body: section(copy.project, input.project) }] : []),
    { name: "cli.md", body: cliCard(input) },
  ];
  const role = input.memberRole ? (copy.role[input.memberRole] ?? input.memberRole) : "";
  const entry = [
    `# ${input.job.key}: ${input.job.title}`,
    "",
    ...(role ? [copy.roleLine(role, input.position.trim()), ""] : []),
    `## ${copy.todo}`,
    input.job.brief.trim() || copy.emptyBrief,
    "",
    `## ${copy.acceptance}`,
    input.job.acceptance.trim() || copy.emptyAcceptance,
    "",
    `## ${copy.pack}`,
    copy.packIntro,
    ...optional.map((file) => `- \`${file.name}\` — ${copy.files[file.name]}`),
    "",
    `## ${copy.finish}`,
    ...copy.finishLines(input.job.key),
    "",
    copy.truth,
  ].join("\n");
  return [{ name: PACK_ENTRY, body: entry }, ...optional];
}

export function snapshotPack(jobKey: string, memberRole: string | null, files: readonly AttemptPackFile[]): SnapshotPack {
  return {
    dir: attemptPackDir(jobKey),
    ...(memberRole ? { role: memberRole } : {}),
    files: files.map((file) => ({ name: file.name, hash: sha256Hex(file.body) })),
  };
}
