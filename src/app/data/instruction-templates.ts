/**
 * Starting texts for a department charter and job descriptions. The standard
 * texts live in src/shared/templates.ts; the owner's versions come from the
 * server (useTemplates) and fall back to these.
 */
import { DEFAULT_TEMPLATES, DEPARTMENT_CHARTER_TEMPLATE, type TemplateKey } from "../../shared/templates";

export { DEPARTMENT_CHARTER_TEMPLATE };

export type JobDescriptionKind = "lead" | "reviewer" | "executor";

export function jobDescriptionKind(role: string): JobDescriptionKind {
  const value = role.trim().toLowerCase();
  if (/lead|руковод|manager|менеджер/.test(value)) return "lead";
  if (/review|провер|qa|audit/.test(value)) return "reviewer";
  return "executor";
}

export const JOB_DESCRIPTION_TEMPLATE_KEY: Record<JobDescriptionKind, TemplateKey> = {
  lead: "jobDescriptionLead",
  executor: "jobDescriptionExecutor",
  reviewer: "jobDescriptionReviewer",
};

/**
 * Accepts a role type directly, or guesses it from a free-text title when the
 * agent has no department yet. `templates` are the owner's texts; missing keys
 * use the standard ones.
 */
export function jobDescriptionTemplate(roleOrKind: string, templates: Partial<Record<TemplateKey, string>> = DEFAULT_TEMPLATES): string {
  const kind = roleOrKind === "lead" || roleOrKind === "reviewer" || roleOrKind === "executor" ? roleOrKind : jobDescriptionKind(roleOrKind);
  const key = JOB_DESCRIPTION_TEMPLATE_KEY[kind];
  return templates[key] ?? DEFAULT_TEMPLATES[key];
}

export const JOB_DESCRIPTION_LABEL: Record<JobDescriptionKind, string> = {
  lead: "руководителя",
  reviewer: "проверяющего",
  executor: "исполнителя",
};
