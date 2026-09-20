import { createHash } from "node:crypto";
import type { SqlDatabase } from "../../db/sql";
import { parseJson } from "../../db/sql";
import type { NeedsInputQuestion } from "../../../shared/contracts/needs-input";
import {
  type OwnerAskOverlayQuestion,
  type OwnerQuestionItem,
  type OwnerQuestionOption,
  type OwnerQuestionPayload,
} from "../../../shared/contracts/owner-question";
import { isOriginThreadId } from "../client-bounce/origin.js";

export type OpenOriginWait = {
  waitId: string;
  jobId: string;
  jobKey: string;
  title: string;
  attemptId: string;
  launchId: string;
  threadId: string;
  questions: NeedsInputQuestion[];
};

const OPTION_LINE =
  /^(?:[•*\-]|\d+[.)])?\s*([A-DА-Г])\s*[.)\]:–—\-]\s*(.+)$/iu;

export function splitQuestionChoices(
  text: string,
  explicit?: NeedsInputQuestion["choices"],
): { prompt: string; options: OwnerQuestionOption[] } {
  if (explicit && explicit.length >= 2) {
    return {
      prompt: text.trim(),
      options: explicit.map((choice) => ({
        id: choice.id,
        label: choice.label,
        ...(choice.description ? { description: choice.description } : {}),
      })),
    };
  }
  const lines = text.split(/\n/);
  const options: OwnerQuestionOption[] = [];
  const body: string[] = [];
  for (const line of lines) {
    const match = OPTION_LINE.exec(line.trim());
    if (match) {
      const label = match[1]!.toUpperCase();
      options.push({
        id: `opt-${label}`,
        label,
        description: match[2]!.trim(),
      });
    } else {
      body.push(line);
    }
  }
  if (options.length >= 2 && options.length <= 4) {
    return { prompt: body.join("\n").trim() || text.trim(), options };
  }
  return { prompt: text.trim(), options: [] };
}

export function optionAnswerText(option: OwnerQuestionOption): string {
  return option.description ? `${option.label}. ${option.description}` : option.label;
}

function normalizePrompt(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

function overlayOptions(question: OwnerAskOverlayQuestion): OwnerQuestionOption[] {
  return question.options.map((option, index) => ({
    id: `ov-${index + 1}`,
    label: option.label,
    description: option.description,
  }));
}

function headerFor(index: number, overlayHeader?: string): string {
  const raw = overlayHeader?.trim() || `Q${index + 1}`;
  return raw.slice(0, 12);
}

export function listOpenOriginWaits(db: SqlDatabase, originThreadId: string): OpenOriginWait[] {
  if (!isOriginThreadId(originThreadId)) return [];
  const rows = db
    .prepare(
      `SELECT w.wait_id, w.job_id, w.attempt_id, w.launch_id, w.thread_id, w.questions_json, j.key, j.title
       FROM agency_job_needs_input_wait w
       JOIN agency_job j ON j.id = w.job_id
       WHERE j.origin_thread_id = ? AND w.closed_at IS NULL AND j.state = 'waiting_input'
       ORDER BY w.created_at`,
    )
    .all(originThreadId) as Array<{
    wait_id: string;
    job_id: string;
    attempt_id: string;
    launch_id: string;
    thread_id: string;
    questions_json: string;
    key: string;
    title: string;
  }>;
  return rows
    .filter((row) => row.thread_id !== originThreadId)
    .map((row) => ({
      waitId: row.wait_id,
      jobId: row.job_id,
      jobKey: row.key,
      title: row.title,
      attemptId: row.attempt_id,
      launchId: row.launch_id,
      threadId: row.thread_id,
      questions: parseJson(row.questions_json) as NeedsInputQuestion[],
    }));
}

/**
 * Same wording across jobs becomes one click row. Overlay options (dispatcher A/B/C)
 * attach by index when every wait has that many questions.
 */
export function buildOwnerQuestionPayload(
  waits: readonly OpenOriginWait[],
  overlay?: readonly OwnerAskOverlayQuestion[],
): OwnerQuestionPayload | null {
  const overlayFits =
    Boolean(overlay?.length) &&
    waits.length > 0 &&
    waits.every((wait) => wait.questions.length === overlay!.length);

  if (waits.length === 0 && overlay?.length) {
    return {
      jobs: [],
      items: overlay.map((question, index) => ({
        id: itemId(question.question, index),
        header: headerFor(index, question.header),
        text: question.question,
        options: overlayOptions(question),
        targets: [],
      })),
    };
  }
  if (waits.length === 0) return null;

  const groups = new Map<string, OwnerQuestionItem>();
  const jobs = waits.map((wait) => ({ key: wait.jobKey, title: wait.title }));
  for (const wait of waits) {
    wait.questions.forEach((question, index) => {
      const overlayQuestion = overlayFits ? overlay![index] : undefined;
      const split = overlayQuestion
        ? { prompt: overlayQuestion.question, options: overlayOptions(overlayQuestion) }
        : splitQuestionChoices(question.text, question.choices);
      const key = normalizePrompt(split.prompt);
      const existing = groups.get(key);
      const target = { waitId: wait.waitId, questionId: question.id };
      if (existing) {
        if (!existing.targets.some((item) => item.waitId === target.waitId && item.questionId === target.questionId)) {
          existing.targets.push(target);
        }
        if (existing.options.length === 0 && split.options.length >= 2) {
          existing.options = split.options;
        }
        return;
      }
      groups.set(key, {
        id: itemId(split.prompt, groups.size),
        header: headerFor(groups.size, overlayQuestion?.header),
        text: split.prompt,
        options: split.options,
        targets: [target],
      });
    });
  }
  const items = [...groups.values()].slice(0, 4);
  if (items.length === 0) return null;
  return { jobs, items };
}

function itemId(prompt: string, index: number): string {
  const digest = createHash("sha256").update(normalizePrompt(prompt), "utf8").digest("hex").slice(0, 12);
  return `q${index + 1}-${digest}`;
}
