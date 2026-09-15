export const CRON_CATCH_UP_HARD_CAP = 24;
export const CRON_DUE_RANGE_CAP = 10_000;
export const CRON_PREVIEW_HARD_CAP = 32;

export type CronMisfire = "skip" | "last" | "catch_up";

export type CronRule = {
  ruleVersionId: string;
  expression: string;
  timezone: string;
  topic: string;
  misfire: CronMisfire;
  catchUpLimit?: number;
};

export type CronSlot = {
  scheduledAtUtc: string;
  timezone: string;
  utcOffsetMinutes: number;
  localHour: number;
  localMinute: number;
};

export type CronInboxDraft = {
  eventId: string;
  topic: string;
  occurredAt: string;
  ruleVersionId: string;
  scheduledAtUtc: string;
  timezone: string;
  utcOffsetMinutes: number;
};

/** Persist-only Inbox. Not a launcher. Duplicate eventId must not create a second row. */
export type CronInboxPort = {
  persistAccepted(draft: CronInboxDraft): { inboxId: string; duplicate: boolean };
};

export type OccurrenceState = "planned" | "emitted" | "skipped";

export type TickItem = {
  ruleVersionId: string;
  scheduledAtUtc: string;
  state: "emitted" | "skipped";
  inboxId: string | null;
  duplicate: boolean;
};

export class CronPlannerError extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}

export function cronEventId(ruleVersionId: string, scheduledAtUtc: string): string {
  return `cron:${ruleVersionId}:${scheduledAtUtc}`;
}
