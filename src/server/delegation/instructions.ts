import type { SqlDatabase } from "../db/sql";
import { agencyLanguage, type AgencyLanguage } from "../i18n/language";
import { rulesForDepartment } from "../rules/work-rules";
import type { MembershipRole } from "../../shared/contracts/membership";
import type { SessionEffectiveMode } from "../../shared/contracts/session-policy";
import { applyPendingSessionPolicy, resolveSessionPolicy } from "./session-policy";
import { formatPendingClientQuestions } from "../runtime/client-bounce";

/**
 * Instructions the Agency gives to agents, in English; the work itself is written
 * in the Agency language.
 *
 * - An ordinary chat in a project bound to the Agency gets thread instructions:
 *   Agency / plugin-delegate = project manager (do not implement); suggest = ask
 *   first; ordinary / off = no Agency text unless this chat has open factory
 *   questions (waiting_input bounced here).
 * - An Agency launch gets its role in the launch prompt (isolated launches do not
 *   receive plugin thread instructions): a lead orchestrates, an executor does the
 *   job, a reviewer checks someone else's version.
 *
 * The provider sits on the thread-start path, so everything here is synchronous
 * SQLite reads and plain string assembly. BB truncates output above 4096 chars;
 * the builders cut lists themselves so the closing rules are never lost.
 */

export const DELEGATION_MODES = ["delegate", "suggest", "off"] as const;
export type DelegationMode = (typeof DELEGATION_MODES)[number];

export const INSTRUCTIONS_LIMIT = 4_000;

/** The owner's base role instruction is theirs to write; the prompt caps it so one layer cannot eat the rest. */
export const PLAYBOOK_LIMIT = 4_000;

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
  /** Owner's base instruction for this role type: the same order of work for every job. */
  playbook?: string | null;
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

/** Role context of the job a thread was launched for; null for an ordinary chat. */
export function readWorkerContext(db: SqlDatabase, threadId: string): WorkerContext | null {
  const attempt = db
    .prepare(`SELECT job_id FROM agency_run_attempt WHERE thread_id = ? ORDER BY attempt_no DESC LIMIT 1`)
    .get(threadId) as { job_id: string } | undefined;
  return attempt ? readJobRoleContext(db, attempt.job_id) : null;
}

/** Role context of a job: who runs it, the department members and the rules that shape the role. */
export function readJobRoleContext(db: SqlDatabase, jobId: string): WorkerContext | null {
  const job = db
    .prepare(
      `SELECT j.id, j.key, j.title, j.assigned_agent_id, d.id AS department_id, d.name AS department_name,
              d.lead_agent_id
       FROM agency_job j
       JOIN agency_department d ON d.id = j.department_id
       WHERE j.id = ?`,
    )
    .get(jobId) as
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
    type: (row.membership_role === "lead" || row.membership_role === "reviewer" || row.membership_role === "assistant"
      ? row.membership_role
      : "executor") as MembershipRole,
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
       WHERE d.archived_at IS NULL
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
    const marker = `- … ${list.length - index} more: bb agency workspace --json`;
    if (used + line.length + 1 + marker.length + 1 > limit) {
      kept.push(marker);
      break;
    }
    kept.push(line);
    used += line.length + 1;
  }
  return [...head, ...kept, ...tail].join("\n").slice(0, limit);
}

/** Instructions are English; the work itself is written in the Agency language. */
export function workLanguageLine(lang: AgencyLanguage = agencyLanguage()): string {
  const name = lang === "en" ? "English" : "Russian";
  return `Language: write job titles, briefs, acceptance criteria, reports, job comments and questions to the owner in ${name}.`;
}

/** Department rules the lead works by. */
function leadRuleLines(rules: WorkerContext["rules"]): string[] {
  if (!rules) return [];
  return [
    `- Department rules: at most ${rules.reworkLimit} rework rounds per job. When they run out the server refuses another rework: compare the versions already made, pick the best one, say in a comment why it is the best and what it still lacks, and hand it to the owner as "accepted with remarks" (report-needs-input). Do not stall on a fourth round.`,
    "- Continue a reviewed result with job return: it delivers the correction into the existing worker context. Cancel and launch is for a real replacement or recovery, not for delivering comments; new worker threads consume the same rework budget. Before a replacement, update the current brief with what remains and attach the exact inputs. Job comments are included as attributed recent history, not evidence of completed checks.",
    "- A loop mark (same_loop, env, contract) makes createJob and return fail with loop_blocked. Do not open another station and do not retry the same thread. Ask the owner with report-needs-input. new_evidence lifts the block.",
    rules.minorDefectsWithoutRound
      ? "- Minor defects do not open a new round: list them in the final report and assemble the result."
      : "- Every open defect, minor ones included, gets a rework subtask and another review.",
    rules.reviewRequired
      ? "- Independent review is required: a reviewer checks every implementation."
      : "- Independent review is optional: check small work yourself against its criteria, hand larger work to a reviewer.",
    ...(rules.autoReview
      ? ["- Auto review is on: when an executor hands in, the Agency creates and queues the review subtask with the version attached (comment \"Автопроверка: создана AG-N\"). Do not create that review yourself; wait for the verdict."]
      : []),
  ];
}

/**
 * The role an Agency launch plays in its job. It is compiled into the launch
 * prompt: plugin thread instructions do not reach isolated launches.
 */
export function buildWorkerInstructions(worker: WorkerContext): string {
  if (worker.isLead) {
    const head = [
      `## Your role: lead of the "${worker.departmentName}" department for ${worker.jobKey}`,
      `Job "${worker.title}" (jobId ${worker.jobId}). You orchestrate the department; you do not implement.`,
    ];
    const line = (member: WorkerMember) => `- ${member.name}${member.role ? ` — ${member.role}` : ""}: ${member.agentId}`;
    const executors = worker.members.filter((member) => member.type === "executor").map(line);
    const reviewers = worker.members.filter((member) => member.type === "reviewer").map(line);
    const list = [
      "",
      "Executors (implementation and rework):",
      ...(executors.length ? executors : ["- none: tell the owner with report-needs-input"]),
      "Reviewers (independent review of other people's versions):",
      ...(reviewers.length ? reviewers : ["- none: check the result yourself against its criteria or ask the owner for a reviewer"]),
    ];
    const tail = [
      "",
      "How to work:",
      `0. Intake first: if the job history already has intake_size, intake_risk and intake_decision, do not rewrite them unless you disagree. Otherwise \`bb agency job comment\` on jobId ${worker.jobId} with a short reason and references intake_size (S|M|L), intake_risk (low|medium|high), intake_decision (accept|split|clarify|return). Then staff the chain: S+low → assistant, cheapest/low-reasoning model, no extra review (a button colour). M → executor; extra review only if the department requires it. L or high risk → executor plus independent review. clarify → report-needs-input (questions bounce to the client chat). Mixed product → split, not return. A pile of jobs: intake each; keep own; foreign → child or return.`,
      `1. Split the job into subtasks with a checkable result: \`bb agency job create\` with parentJobId=${worker.jobId}, the departmentId and the member's assignedAgentId. The server assigns the key. Work of another department is a subtask in that department for its lead.`,
      "   Give implementation subtasks a `contract`: readFirst (what to read before starting), interfaces (signatures and invariants to keep), mayChange (only the files this subtask owns), mustNotTouch, checks (the commands it must pass). It is frozen at launch. The subtask's bindingId is this job's folder unless the job layer lists other project folders or employee workplaces.",
      "   Two subtasks that may change the same files do not run at once: the Agency holds the later one in the launch queue until the first is done. Give each subtask its own files, or order them with `job depend`.",
      "2. Implementation and rework go to executors, review to reviewers. Pass inputs with `bb agency job attach-input`. Launch with `bb agency launch readiness`, then `launch prepare`.",
      "   Order: `bb agency job depend` (jobId waits for dependsOnJobId). Creating an assigned subtask already puts it in the launch queue; a waiting one starts by itself when its dependencies are done. Work that must follow another department's accepted result: `bb agency job next-step` on the earlier job.",
      "3. When a work subtask (another department's too) moves to review, waiting_input, blocked, done or canceled, the Agency messages this thread. Automatic QC children do not. Do not poll in a loop: end your turn and wait.",
      "4. Check each subtask against its acceptance criteria. A defect means a rework subtask and another independent review, not a fix by your own hands. Accept (`bb agency artifact accept`) only versions of subtasks you assigned; the server blocks accepting your own work.",
      ...leadRuleLines(worker.rules),
      "5. Finish with a summary report .agency/jobs/<main job key>/report.md published as a version and a final job comment. Do not accept your own result: acceptance belongs to the owner. Comments are Markdown: first line the outcome, details as a list, no run_/thr_/job_ ids unless needed.",
      "6. A job outside the department's scope (see Accepts / Does not accept in the department process): do not implement it. Mixed product → children in accepting departments, not a Return of the root. Return + blocked only when no department fits.",
      "A subtask returned to you as blocked with \"Return\" (or \"Возврат\"): reassign it by role, move it to the right department or cancel it; stop a stuck attempt with `bb agency launch cancel`.",
      workLanguageLine(),
    ];
    return withPlaybook(worker, [fit(head, list, tail)]);
  }
  const common = [
    "- Job comments are Markdown: first line the outcome, details as a list (`\\n` line breaks in JSON), technical ids only when needed. Long material goes to the report.",
    "- Do not create new Agency jobs and do not hand this work on: splitting work is the lead's job.",
    "- A question for the owner or conflicting instructions: `bb agency job report-needs-input`, then end your turn. The questions go to the chat that commissioned the job, not the Agency card.",
    "- Handing in means a published version and a final job comment. Without the final comment after publishing, the job does not go to review.",
    `- Ending a turn without a published version or a final comment brings a reminder; after ${worker.rules?.completionReminders ?? 2} reminders the job goes to the lead as blocked.`,
    `- The Agency watches the attempt: ${worker.rules?.watchStallMinutes ?? 30} min without new events or ${worker.rules?.watchCeilingHours ?? 2} h of continuous work sends the job to the lead as blocked. Split long work into stages and note them in comments.`,
    "- If the job has an execution contract, start with readFirst, keep interfaces as they are, change only what mayChange lists, leave mustNotTouch alone, run every check and list them with their output in the final comment. Going outside it is a question to the lead, not a decision.",
    "- Work you could not finish is reported as such: say which acceptance criteria are not met and what is missing. A promise to do it later is not a result.",
    workLanguageLine(),
  ];
  if (worker.assigneeType === "assistant") {
    return withPlaybook(worker, [
      `## Your role: assistant in ${worker.jobKey}`,
      `Job "${worker.title}" of the "${worker.departmentName}" department. You prepare material for a colleague; the decisions are theirs.`,
      "- Read and collect only what the brief names. Every fact carries a reference (path:line, URL, clause, date); what you did not find is said plainly.",
      "- Do not decide what to do next and do not create jobs: that belongs to the lead and to the employee you help.",
      "- Hand in a short digest as a version and a final comment. Your work goes to a colleague, so it needs no independent review.",
      ...common,
    ]);
  }
  if (worker.assigneeType === "reviewer") {
    return withPlaybook(worker, [
      `## Your role: reviewer of ${worker.jobKey}`,
      `Job "${worker.title}" of the "${worker.departmentName}" department. You review someone else's version independently; you do not fix it.`,
      "- Review the input versions of this job (`bb agency job get` → inputs, then `bb agency artifact open` with the hash), not working files on trust. No input version or no criteria: return it to the lead.",
      "- Do not edit the reviewed result. Describe defects (criterion → place → how to reproduce → severity: blocking / important / minor); the executor fixes them.",
      ...(worker.rules?.minorDefectsWithoutRound ? ["- In this department minor defects do not open a new round: the verdict is \"accept with remarks\" when only minor defects remain."] : []),
      "- The job turns out to be a review of your own work, or an implementation: do not take it. `bb agency job comment` \"Return: reason\", then `bb agency job transition` to blocked and end your turn.",
      "- Hand in: verdict report .agency/jobs/<key>/report.md (verdict, criteria table, defects, commands and output) → `bb agency artifact create` and `artifact publish` → final `bb agency job comment` with the verdict → end your turn. Do not accept the result: the lead or the owner decides.",
      ...common,
    ]);
  }
  return withPlaybook(worker, [
    `## Your role: executor of ${worker.jobKey}`,
    `Job "${worker.title}" of the "${worker.departmentName}" department. Do the work yourself within the brief.`,
    "- First compare the job with your job description. Not your kind of work, or required inputs are missing: do not start. `bb agency job comment` \"Return: reason; who fits; what is missing\", then `bb agency job transition` to blocked and end your turn. The lead is notified.",
    "- Hand in: report .agency/jobs/<key>/report.md (outcome, what was done and where, how it was checked, what was not done) → `bb agency artifact create` and `artifact publish` → final `bb agency job comment` for the lead with a link to the version → end your turn. Saying \"done\" is not acceptance.",
    ...common,
  ]);
}

/**
 * The owner's base instruction of this role type goes under the role section: one order of work
 * for every job, so it never has to be copied into every job description.
 */
function withPlaybook(worker: WorkerContext, lines: string[]): string {
  const playbook = worker.playbook?.trim();
  return [...lines, ...(playbook ? ["", playbook.slice(0, PLAYBOOK_LIMIT)] : [])].join("\n");
}

/** Instructions for ordinary BB chats: route work to the Agency or do it in the chat. */
export function buildSessionInstructions(input: {
  mode: Exclude<SessionEffectiveMode, "ordinary">;
  routes: ProjectRoutes;
  totalDepartments: number;
}): string | null {
  const { workplaces, departments } = input.routes;
  if (workplaces.length === 0 || departments.length === 0) {
    if (input.totalDepartments === 0) return null;
    return [
      "## BB Agency",
      `This BB has an Agency: departments of AI employees with leads (${input.totalDepartments}). ${workplaces.length === 0 ? "This project is not connected to it." : "No department serves this project."}`,
      "If the owner asks to hand larger work to a team, say the project has to be connected in the Agency (Projects section). Do not create a job yourself.",
      "Ask the owner to connect it with `bb agency project bind`. Do not create the folder tree or bindings yourself.",
    ].join("\n");
  }
  const pm = input.mode === "pm" || input.mode === "delegate";
  const suggest = input.mode === "suggest";
  const single = workplaces.length === 1 ? workplaces[0] : null;
  const workplaceLine = single
    ? `Work of this project runs on ${single.hostName ?? single.hostId} in ${single.root} (bindingId ${single.bindingId}).`
    : "Where work runs: pick the folder of your environment (compare with pwd); the employee launches on that machine.";
  const extraPlaces = single ? [] : workplaces.map((place) => `- ${place.bindingId}: ${place.hostName ?? place.hostId} — ${place.root}`);
  const head = pm
    ? [
        "## BB Agency: you are the project manager",
        "This chat is the Agency office. The owner only talks to you. You decide the route and hand work to department leads — the Agency analog of a solo PM / orchestrator. You do not implement.",
        "If an Agency job pauses for materials, a native choice card opens in this chat. Do not list A/B/C in a message. If the card does not appear, call agency_ask_owner and wait for Send. Do not send them to the Agency card.",
        "Do here: short answers, status of jobs you created, one-off facts, urgent BB or Agency setup.",
        "Never do here: code, research reports, audits, copy, design, or any multi-step result. Those become Agency jobs on the department lead immediately. Do not ask the owner to create the job or confirm twice, unless they are choosing between options.",
        "Not sure which department: name the route in one sentence and wait. Phrase-to-department map and what each department already has: agency skill references/routing.md. Mixed product: agency skill references/chains.md — pick CH-*, create only the root. Live IDs from workspace, never invented.",
        "You are a child thread or subagent already given part of a job: do that part, do not delegate it again.",
        "",
        workplaceLine,
        ...extraPlaces,
        "",
        "Departments (choose by the kind of result, not by model):",
        "New program or service: the root job goes to the spec department with `\"workKind\":\"new-program\"`. A bugfix or one function in a known module: `bugfix` / `feature` on a job in the department that owns that result.",
      ]
    : [
        "## BB Agency: ask before handing work",
        "You may answer trivia and one-off facts here.",
        "For any real task (code, research, writing, design, audit, or a result that should outlive this chat): ask the owner once — do it in this chat, or create an Agency job for the department that owns that result.",
        "After they choose Agency, create the job using agency skill references/routing.md (phrase → department). After they choose this chat, do the work here. Do not create a job until they answer, unless they already said to delegate.",
        "You are a child thread or subagent already given part of a job: do that part, do not delegate it again.",
        "",
        workplaceLine,
        ...extraPlaces,
        "",
        "Departments (choose by the kind of result, not by model):",
        "New program or service: the root job goes to the spec department with `\"workKind\":\"new-program\"`. A bugfix or one function in a known module: `bugfix` / `feature` on a job in the department that owns that result.",
      ];
  const list = departments.map(
    (department) =>
      `- "${department.name}": ${department.purpose} Lead: ${department.leadName} (${department.leadAgentId}); members: ${department.memberCount}; departmentId ${department.departmentId}${department.onlyBindingIds ? `; only for ${department.onlyBindingIds.join(", ")}` : ""}`,
  );
  const bindingId = single ? single.bindingId : "<bindingId of the folder>";
  const tail = [
    "No department fits: do not create a job; tell the owner which department is missing.",
    "",
    "Before creating a job: this chat folder must sit inside a binding canonicalRoot on this machine (`bb agency workspace --json`). One binding per project; do not bind a section.",
    "No matching binding: tell the owner to connect the project (`bb agency project bind`). Do not create the job, folder tree, or bindings yourself.",
    "Chat folder is inside a BB section (`bb project-folders list`: deepest folder with this project's projectId whose path contains the chat folder): pass that folder id as `sectionId`. Section-only facts: knowledge save with scopeKind \"section\", scopeId = that id, parentBindingId = the binding. Project-wide facts use scopeKind \"project\".",
    "",
    pm ? "Create the job now:" : suggest ? "After the owner agrees, delegate:" : "Delegate:",
    `\`bb agency job create --input-json '{"requestId":"<new UUID>","bindingId":"${bindingId}","departmentId":"…","assignedAgentId":"<department lead>","title":"…","brief":"…","acceptance":"…","sectionId":"<section folder id or omit>","workKind":"<new-program|feature|bugfix or omit>"}'\``,
    "- The server assigns the key. brief: goal, inputs, limits (what not to touch). acceptance: a checkable criterion.",
    "- workKind (optional): `new-program` for a new program or service (root job in the spec department); `feature` or `bugfix` for one function or a fix in a known module (that department). Omit on older jobs.",
    "- Assign the department lead: the lead splits the work and assigns it. Do not assign executors past the lead.",
    pm
      ? "- Tell the owner the AG-N key. Creating the job puts it in the launch queue; do not ask the owner to queue or press Launch. If the environment is not ready, say it is waiting and will start itself. Never announce a live run without a `bb agency launch prepare` receipt."
      : "- Then tell the owner the AG-N key and the next step. Do not do the delegated work yourself; never announce a launch without a `bb agency launch prepare` receipt.",
    "- Creating departments or employees and writing job descriptions: follow the `agency` skill.",
    workLanguageLine(),
  ];
  return fit(head, list, tail);
}

/**
 * Thread instructions from the Agency. Only ordinary chats get them: an Agency
 * launch is isolated, so its role travels in the launch prompt instead.
 */
export function buildAgencyInstructions(
  db: SqlDatabase,
  ctx: { threadId: string; projectId: string },
  mode: DelegationMode,
  hostName?: (hostId: string) => string | undefined,
): string | null {
  if (readWorkerContext(db, ctx.threadId)) return null;
  applyPendingSessionPolicy(db, { bbProjectId: ctx.projectId, threadId: ctx.threadId }, new Date().toISOString());
  const pending = formatPendingClientQuestions(db, ctx.threadId);
  const route = resolveSessionPolicy(db, { bbProjectId: ctx.projectId, threadId: ctx.threadId }, mode);
  const session = route.effective === "ordinary" ? null : buildSessionInstructions({
    mode: route.effective,
    routes: readProjectRoutes(db, ctx.projectId, hostName),
    totalDepartments: countAllDepartments(db),
  });
  if (!pending && !session) return null;
  return [pending, session].filter(Boolean).join("\n\n");
}
