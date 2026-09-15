import type { State } from "../prototype/data";

/**
 * Attention marker of the job list.
 *
 * The list is grouped by status, so repeating the status on every row says
 * nothing new. What the section header cannot tell is how long a row has been
 * sitting still, and whether the person is the one holding it up. That is what
 * this marker carries.
 */
export type AttentionTone =
  /** Waits for a human decision and has waited long enough to be a problem. */
  | "overdue"
  /** Waits for a human decision. */
  | "waiting"
  /** The agency is working or the job has not started; time is informational. */
  | "quiet"
  /** Finished or cancelled: nothing to watch. */
  | "none";

export type JobAttention = {
  tone: AttentionTone;
  /** Compact age since the last change, or null when the job has no timestamp. */
  age: string | null;
  /** Full sentence for the tooltip and for assistive technology. */
  hint: string;
};

/** States where the agency cannot move until a person acts. */
export const HUMAN_BLOCKING_STATES: readonly State[] = ["blocked", "waiting_input", "review"];

/** A job waiting on a person for longer than this reads as overdue. */
export const OVERDUE_AFTER_MS = 24 * 60 * 60 * 1000;

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

const REASON: Record<State, string> = {
  blocked: "Ждёт уточнения вводных",
  waiting_input: "Ждёт вашего ответа",
  review: "Ждёт вашего решения",
  running: "Исполнитель работает",
  queued: "В очереди на запуск",
  backlog: "Не передана в работу",
  done: "Результат принят",
  canceled: "Задача отменена",
};

/** Compact age: «12 мин», «3 ч», «5 дн», «2 нед». Null when the instant is unusable. */
export function relativeAge(instant: string | null | undefined, now: number): string | null {
  if (!instant) return null;
  const at = Date.parse(instant);
  if (Number.isNaN(at)) return null;
  const elapsed = now - at;
  if (elapsed < 0) return null;
  if (elapsed < MINUTE) return "только что";
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)} мин`;
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)} ч`;
  if (elapsed < WEEK) return `${Math.floor(elapsed / DAY)} дн`;
  return `${Math.floor(elapsed / WEEK)} нед`;
}

export function jobAttention(job: { state: State; updatedAt?: string }, now: number): JobAttention {
  const age = relativeAge(job.updatedAt, now);
  const reason = REASON[job.state];
  if (job.state === "done" || job.state === "canceled") {
    return { tone: "none", age: null, hint: reason };
  }
  const hint = age ? `${reason}. Без изменений ${age}` : reason;
  if (!HUMAN_BLOCKING_STATES.includes(job.state)) {
    return { tone: "quiet", age, hint };
  }
  const at = job.updatedAt ? Date.parse(job.updatedAt) : Number.NaN;
  const overdue = !Number.isNaN(at) && now - at >= OVERDUE_AFTER_MS;
  return { tone: overdue ? "overdue" : "waiting", age, hint };
}
