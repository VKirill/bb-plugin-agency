import { z } from "zod";
import { displayNameSchema, jobKeySchema, opaqueIdSchema, utcInstantSchema } from "./ids";
import { jobTeamAgentIdsSchema } from "./job-team";
import { knowledgeSectionIdSchema } from "./knowledge-scope";
import { changeCommandSchema, createCommandSchema, revisionedRecordSchema } from "./revision";

export const jobStateSchema = z.enum([
  "backlog",
  "queued",
  "running",
  "review",
  "waiting_input",
  "blocked",
  "done",
  "canceled",
]);

export const jobPrioritySchema = z.enum(["low", "normal", "high", "urgent"]);

export const WORK_KINDS = ["new-program", "feature", "bugfix"] as const;
export const workKindSchema = z.enum(WORK_KINDS);
export type WorkKind = z.infer<typeof workKindSchema>;

const contractLineSchema = z.string().trim().min(1).max(500);

/**
 * Execution contract: the boundaries of the work, set by whoever delegates it.
 * It is pinned in the launch snapshot; a change after preparing invalidates the launch.
 */
export const jobContractSchema = z
  .object({
    /** What to read before starting: files, documents, previous results. Absent on older contracts. */
    readFirst: z.array(contractLineSchema).max(30).optional(),
    /** Signatures, contracts and invariants the result must keep. Absent on older contracts. */
    interfaces: z.array(contractLineSchema).max(30).optional(),
    /** Files, modules or areas the employee may change. */
    mayChange: z.array(contractLineSchema).max(30).default([]),
    /** What must stay untouched. */
    mustNotTouch: z.array(contractLineSchema).max(30).default([]),
    /** Checks that must pass before hand-in: commands, measurements, reviews. */
    checks: z.array(contractLineSchema).max(30).default([]),
  })
  .strict();

export type JobContract = z.infer<typeof jobContractSchema>;

export function contractIsEmpty(contract: JobContract | null | undefined): boolean {
  return !contract || CONTRACT_PARTS.every((part) => (contract[part] ?? []).length === 0);
}

/** Order of the contract in its text, in the card and in the form. */
export const CONTRACT_PARTS = ["readFirst", "interfaces", "mayChange", "mustNotTouch", "checks"] as const;
export type ContractPart = (typeof CONTRACT_PARTS)[number];

/** Canonical text of a contract: pinned in the prompt and hashed in the snapshot. Empty contract → "". */
export function contractText(contract: JobContract | null | undefined): string {
  if (!contract || contractIsEmpty(contract)) return "";
  const block = (title: string, lines: readonly string[]) => (lines.length ? [title, ...lines.map((line) => `- ${line}`)] : []);
  return [
    // Appended in this order; an empty list adds nothing, so contracts written before
    // «Прочитать сначала» and «Интерфейсы» keep their text and their snapshot hash.
    ...block("Можно менять:", contract.mayChange),
    ...block("Нельзя трогать:", contract.mustNotTouch),
    ...block("Проверки перед сдачей:", contract.checks),
    ...block("Прочитать сначала:", contract.readFirst ?? []),
    ...block("Интерфейсы и инварианты:", contract.interfaces ?? []),
  ].join("\n");
}

export const jobSchema = revisionedRecordSchema
  .extend({
    id: opaqueIdSchema,
    key: jobKeySchema,
    bindingId: opaqueIdSchema,
    departmentId: opaqueIdSchema,
    title: displayNameSchema,
    brief: z.string().trim().min(1).max(20_000),
    acceptance: z.string().trim().min(1).max(20_000),
    state: jobStateSchema,
    parentJobId: opaqueIdSchema.nullable(),
    /** project-folders section id; opaque string, not validated against that plugin. */
    sectionId: knowledgeSectionIdSchema.nullable().optional(),
    /** How the work is classified; absent on older jobs. */
    workKind: workKindSchema.nullable().optional(),
    assignedAgentId: opaqueIdSchema.nullable(),
    reviewerAgentIds: jobTeamAgentIdsSchema.optional(),
    observerAgentIds: jobTeamAgentIdsSchema.optional(),
    priority: jobPrioritySchema,
    dueAt: utcInstantSchema.nullable(),
    /** Execution contract; absent when nothing is set. */
    contract: jobContractSchema.optional(),
    /** Work profile of the project this job follows: voice, style, approved samples. */
    workProfileKey: z.string().trim().max(60).nullable().optional(),
    /** BB thread that commissioned the job. waiting_input questions bounce here. */
    originThreadId: z.string().trim().min(8).max(80).optional(),
    /** When the job last entered done/canceled. Listed in the workspace snapshot only. */
    closedAt: utcInstantSchema.nullable().optional(),
  })
  .strict();

/**
 * How long a closed job stays on the working board. Hiding is a view rule: the
 * job, its history and its accepted versions stay in the database. 0 = never hide.
 */
export const boardPolicySchema = z
  .object({
    hideClosedSubtasksAfterHours: z.number().min(0).max(8_760),
    hideClosedMainTasksAfterHours: z.number().min(0).max(8_760),
    /**
     * Soft work-in-progress limits of the kanban columns. Over the limit the column
     * header turns amber; nothing is blocked. Absent or 0 — no limit.
     */
    wipLimits: z
      .object({
        queued: z.number().int().min(0).max(999),
        running: z.number().int().min(0).max(999),
        attention: z.number().int().min(0).max(999),
        review: z.number().int().min(0).max(999),
      })
      .partial()
      .strict()
      .optional(),
  })
  .strict();

export const DEFAULT_BOARD_POLICY: BoardPolicy = {
  hideClosedSubtasksAfterHours: 1,
  hideClosedMainTasksAfterHours: 24,
};

export const jobDependencySchema = z
  .object({
    jobId: opaqueIdSchema,
    dependsOnJobId: opaqueIdSchema,
  })
  .strict();

/**
 * Delegation from any chat should need only placement, title, brief and
 * acceptance. Omitted key gets the next free AG-N inside the create transaction.
 */
export const createJobCommandSchema = createCommandSchema
  .extend({
    key: jobKeySchema.optional(),
    bindingId: opaqueIdSchema,
    departmentId: opaqueIdSchema,
    title: displayNameSchema,
    brief: z.string().trim().min(1).max(20_000),
    acceptance: z.string().trim().min(1).max(20_000),
    parentJobId: opaqueIdSchema.nullable().default(null),
    sectionId: knowledgeSectionIdSchema.nullable().optional(),
    workKind: workKindSchema.nullable().optional(),
    assignedAgentId: opaqueIdSchema.nullable().default(null),
    reviewerAgentIds: jobTeamAgentIdsSchema.optional(),
    observerAgentIds: jobTeamAgentIdsSchema.optional(),
    priority: jobPrioritySchema.default("normal"),
    dueAt: utcInstantSchema.nullable().default(null),
    contract: jobContractSchema.nullable().optional(),
    workProfileKey: z.string().trim().max(60).nullable().optional(),
    originThreadId: z.string().trim().min(8).max(80).optional(),
    /**
     * Without assignedAgentId: let the server pick. `lead` — the department lead;
     * `executor` / `reviewer` — the active launchable member of that role type
     * with the fewest open jobs.
     */
    assignment: z.enum(["lead", "executor", "reviewer"]).optional(),
  })
  .strict();

export const updateJobCommandSchema = changeCommandSchema
  .extend({
    jobId: opaqueIdSchema,
    title: displayNameSchema.optional(),
    brief: z.string().trim().min(1).max(20_000).optional(),
    acceptance: z.string().trim().min(1).max(20_000).optional(),
    bindingId: opaqueIdSchema.optional(),
    departmentId: opaqueIdSchema.optional(),
    assignedAgentId: opaqueIdSchema.nullable().optional(),
    reviewerAgentIds: jobTeamAgentIdsSchema.optional(),
    observerAgentIds: jobTeamAgentIdsSchema.optional(),
    priority: jobPrioritySchema.optional(),
    dueAt: utcInstantSchema.nullable().optional(),
    /** null clears the contract. */
    contract: jobContractSchema.nullable().optional(),
    workProfileKey: z.string().trim().max(60).nullable().optional(),
    workKind: workKindSchema.nullable().optional(),
    originThreadId: z.string().trim().min(8).max(80).optional(),
  })
  .strict();

export const jobTransitionCommandSchema = changeCommandSchema
  .extend({
    jobId: opaqueIdSchema,
    to: jobStateSchema,
    reworkComment: z.string().trim().min(1).max(8_000).optional(),
  })
  .strict();

export type JobState = z.infer<typeof jobStateSchema>;
export type JobPriority = z.infer<typeof jobPrioritySchema>;
export type Job = z.infer<typeof jobSchema>;
export type BoardPolicy = z.infer<typeof boardPolicySchema>;
export type JobDependency = z.infer<typeof jobDependencySchema>;
export type CreateJobCommand = z.infer<typeof createJobCommandSchema>;
export type UpdateJobCommand = z.infer<typeof updateJobCommandSchema>;
export type JobTransitionCommand = z.infer<typeof jobTransitionCommandSchema>;
