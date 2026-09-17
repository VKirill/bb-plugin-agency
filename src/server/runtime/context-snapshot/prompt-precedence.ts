/** Instruction layers in compile order. A later layer does not cancel an earlier one. */
export const PROMPT_LAYER_ORDER = [
  "platform",
  "agency",
  "project",
  "department",
  "agent",
  "job",
  "handoff",
] as const;

export const PROMPT_PRECEDENCE_DEPARTMENT = [
  "Layer department does not cancel project or agency.",
  "ProcessVersion.acceptance is a reusable result class: schema, validate, publish via Agency CLI.",
  "It is not one other job's exact path or marker.",
  "A lower layer does not waive this acceptance.",
].join("\n");

export const PROMPT_PRECEDENCE_JOB = [
  "Layer job does not cancel department, agent, or project.",
  "Job.acceptance is the exact path and marker for this job.",
  "If department acceptance and job acceptance cannot both be satisfied, name both sources (processVersion id and job id) and stop as needs clarification.",
  "Do not auto-pick one text. Do not treat the run as success. Do not accept.",
  "Watcher does not set Job.waiting_input: idle without a hash-verified published artifact leaves the job running; idle with a hash-verified current version moves the job to review, which is not accept.",
  "Report meaningful milestones to this job's activity using bb agency job comment --input-json with requestId (a new UUID), jobId (this job), and comment (public progress text). Record what was completed, the result of validation, any handoff, and the next step. Write concise updates at meaningful milestones, not one comment per tool call. Do not include private reasoning or secrets. Comments do not change job state or notify another worker; use the appropriate Agency command for those actions. If posting fails, report the failure rather than claiming the update was saved.",
  "When coordinating child jobs, reconcile every child before the final parent report. Do not leave an obsolete submission waiting for review after its replacement has been accepted. Record the replacement job and reason in the obsolete job history; if no further work is required and your authority allows it, cancel the superseded job through Agency. Never accept an invalid artifact just to clear the queue. If a child still needs a decision, state that explicitly in the parent report.",
  "Hand in the job in this order: (1) write the report to .agency/jobs/<job key>/report.md with the outcome, what changed and where, how it was checked, and what is not done; keep other job outputs next to it unless the brief names a project path; (2) publish it with bb agency artifact create and bb agency artifact publish (also publish key result files the acceptance names); (3) post a final bb agency job comment for the lead with the outcome in two or three sentences and the published artifact id and version; (4) end the turn. Ending a turn without a published version leaves the job running and triggers a reminder; after repeated reminders the job is blocked for the lead.",
  "For an Agency job question, call reportNeedsInput once. After it succeeds, end the current provider turn with a short final message containing the waitId. Wait for an official continuation in a later turn.",
  "Do not open AskUserQuestion or another native provider interaction for a question already recorded in Agency. Do not keep the turn active with sleep, polling, or a second question channel; that blocks delivery of the owner's Agency answer.",
].join("\n");
