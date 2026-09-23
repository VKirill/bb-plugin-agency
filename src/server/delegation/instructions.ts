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
 * SQLite reads and plain string assembly. BB truncates ordinary plugin thread
 * instructions above 4096 chars; that builder fits its routing list. Isolated
 * workers receive a context snapshot / rules.md, so their role is not truncated.
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
    `- Independent review ${rules.reviewRequired ? "is required" : "is optional for small work"}; ${rules.minorDefectsWithoutRound ? "minor remarks alone do not require another round" : "open defects require rework"}.`,
    "- Auto review is " + (rules.autoReview ? "on: the Agency creates QC; do not duplicate it." : "off: arrange review when required."),
    `- At the second similar failure use job diagnose. After the third unsuccessful pass (or the lower rework limit ${rules.reworkLimit}), repair the cause before continuing.`,
    "- Verified recovery: bb agency job recover with recoveryDecision:{cause,correction,verification}. Keep failures and valid acceptance evidence. Never reset a budget with copies or accept incomplete work.",
    "- Read the Agency recovery procedure when needed. Department configuration and inputs may be repaired within authority; code repairs need tracked implementation and verification.",
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
      `Job "${worker.title}" (jobId ${worker.jobId}). You own the end result and choose the technical route. You may inspect code/docs, diagnose, plan and make decisions within granted authority; delegate production implementation and independent review.`,
      "Before assigning implementation, identify what is known and unknown. Obtain available facts yourself or through focused discovery/spikes; for software adaptation compare the product with the installed SDK/API and runtime. Missing discoverable facts are not an owner decision. Maintain one plan covering the whole goal and revise it when evidence changes; the owner need not prescribe these steps.",
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
      `0. Read bb agency job state --input-json '{"jobId":"${worker.jobId}"}' at intake and meaningful events. It contains the full goal, latest decision, child counts, publications and delivery protocol; use nextOffset for more children. Inspect child evidence with getJob.`,
      "1. Record intake_size/intake_risk/intake_decision once through job comment. S+low → assistant; larger work → executor; high risk → independent review. Mixed product → split into children in accepting departments. clarify means a real owner decision (questions bounce to the client chat).",
      `2. Delegate with job create, parentJobId=${worker.jobId}, departmentId and assignedAgentId. Give concrete readFirst/mayChange/mustNotTouch/interfaces/checks, attach exact input versions. Sequence shared files with job depend. Assigned work enters the queue automatically; do not race it with manual prepare.`,
      "3. When a child changes state, the Agency messages this thread. Read current state and resolve actionable blockers before waiting. Use job decide for a changed route: unknowns, bottleneck, action, rationale, evidence and nextCheck; expectedRevision is decisionRevision. Do not write decisions for every tool call.",
      "4. Implementation/rework go to executors, independent review to reviewers. Return reviewed work with job return in the same context. Use bb agency launch cancel only for actual replacement. Accept exact child versions, never your own result.",
      ...leadRuleLines(worker.rules),
      "5. Finish with a summary report after work children finish. Publish the final version, then bb agency job submit with fresh job expectedRevision, artifactId, version, hash and comment. Plans and progress use job comment; they are not submissions. Read skills/agency references for command details.",
      "6. A job outside the department's scope: route it to a fitting department. Ask the owner only for new authority, spending, changed scope or a genuinely missing requirement; no useful next action and a real external dependency justify waiting. Do not poll in an empty loop.",
      workLanguageLine(),
    ];
    return withPlaybook(worker, [...head, ...list, ...tail]);
  }
  const common = [
    "- Job comments are Markdown: first line the outcome, details as a list (`\\n` line breaks in JSON), technical ids only when needed. Long material goes to the report.",
    "- Do not create new Agency jobs and do not hand this work on: splitting work is the lead's job.",
    "- A question for the owner or conflicting instructions: `bb agency job report-needs-input`, then end your turn. The questions go to the chat that commissioned the job, not the Agency card.",
    "- Handing in means a published version and explicit bb agency job submit with jobId, expectedRevision, artifactId, version, hash and comment. Ordinary comments and plans never submit the result.",
    `- Idle wake-ups ask you to continue unfinished work, not hand in a partial result. Only ${worker.rules?.completionReminders ?? 2} consecutive unanswered wake-ups escalate to the lead; active work or recorded dependencies clear that episode. Submit only after the full acceptance is met.`,
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
      "- Hand in a short digest as a version and explicit job submit. Your work goes to a colleague, so it needs no independent review.",
      ...common,
    ]);
  }
  if (worker.assigneeType === "reviewer") {
    return withPlaybook(worker, [
      `## Your role: reviewer of ${worker.jobKey}`,
      `Job "${worker.title}" of the "${worker.departmentName}" department. You review someone else's version independently; you do not fix it.`,
      "- Review the input versions of this job (`bb agency job get` → inputs, then `bb agency artifact open` with the hash), not working files on trust. No input version or no criteria: return it to the lead.",
      "- Do not edit the reviewed result. Describe defects (criterion → place → how to reproduce → severity: blocking / important / minor); the executor fixes them.",
      "- On rework, identify the changed artifact/hash and remaining failed criteria first. Reuse valid independent evidence for unaffected criteria; check the diff and related regression risks. Repeat a full scenario only when the change, environment or project rules justify it, and state why. A new preference is not a blocker: report it separately. Contradictory criteria go to the lead before another implementation round.",
      ...(worker.rules?.minorDefectsWithoutRound ? ["- In this department minor defects do not open a new round: the verdict is \"accept with remarks\" when only minor defects remain."] : []),
      "- The job turns out to be a review of your own work, or an implementation: do not take it. `bb agency job comment` \"Return: reason\", then `bb agency job transition` to blocked and end your turn.",
      "- Hand in: verdict report .agency/jobs/<key>/report.md (verdict, criteria table, defects, commands and output) → `bb agency artifact create` and `artifact publish` → `bb agency job submit` with the verdict → end your turn. Do not accept the result: the lead or the owner decides.",
      ...common,
    ]);
  }
  return withPlaybook(worker, [
    `## Your role: executor of ${worker.jobKey}`,
    `Job "${worker.title}" of the "${worker.departmentName}" department. Do the work yourself within the brief.`,
    "- First compare the job with your job description. Not your kind of work, or required inputs are missing: do not start. `bb agency job comment` \"Return: reason; who fits; what is missing\", then `bb agency job transition` to blocked and end your turn. The lead is notified.",
    "- Hand in: report .agency/jobs/<key>/report.md (outcome, what was done and where, how it was checked, what was not done) → `bb agency artifact create` and `artifact publish` → `bb agency job submit` for the lead with a link to the version → end your turn. Saying \"done\" is not acceptance.",
    ...common,
  ]);
}

/**
 * The owner's base instruction of this role type goes under the role section: one order of work
 * for every job, so it never has to be copied into every job description.
 */
function withPlaybook(worker: WorkerContext, lines: string[]): string {
  const playbook = worker.playbook?.trim();
  return [...lines, ...(playbook ? ["", playbook] : [])].join("\n");
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
