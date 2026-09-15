import { describe, expect, it } from "vitest";
import {
  ACCEPT_AMBIGUOUS_NOTICE,
  ACCEPT_NO_TARGET_NOTICE,
  ACCEPT_STALE_SELECTION_NOTICE,
  acceptSelectionKey,
  ACCEPT_THEN_DONE_NOTICE,
  JOB_CANCELED_LABEL,
  LAST_LAUNCH_UNACCEPTED,
  WAITING_INPUT_STATUS_NOTICE,
  activityRoleLabel,
  interpretButtonDisabled,
  jobKanbanMoveRefusal,
  jobPersistStatusRefusal,
  resolveAcceptTarget,
} from "../src/app/data/job-lifecycle";
import { currentWorkLabel, historicalAttemptNote } from "../src/app/data/job-team";
import type { TaskFile } from "../src/app/prototype/data";

const hash = "a".repeat(64);
const fileA: TaskFile = { id: "art_aaaaaaaaaaaaaaaa", name: "a.md", size: 1, content: "", kind: "text", version: 1, hash };
const fileB: TaskFile = { id: "art_bbbbbbbbbbbbbbbb", name: "b.md", size: 1, content: "", kind: "text", version: 2, hash: "b".repeat(64) };

describe("job lifecycle UI guards", () => {
  it("blocks kanban from waiting_input and done without accept", () => {
    expect(jobKanbanMoveRefusal({ state: "waiting_input", sourceState: "waiting_input" }, "blocked")).toBe(WAITING_INPUT_STATUS_NOTICE);
    expect(jobKanbanMoveRefusal({ state: "review" }, "done")).toBe(ACCEPT_THEN_DONE_NOTICE);
    expect(jobKanbanMoveRefusal({ state: "running", sourceState: "running" }, "review")).toBeTruthy();
    expect(jobKanbanMoveRefusal({ state: "backlog" }, "queued")).toBeNull();
  });

  it("refuses persist status to done and waiting_input moves", () => {
    expect(jobPersistStatusRefusal({ state: "review" }, "done")).toBe(ACCEPT_THEN_DONE_NOTICE);
    expect(jobPersistStatusRefusal({ state: "waiting_input" }, "running")).toBe(WAITING_INPUT_STATUS_NOTICE);
  });

  it("disables interpret on waiting_input even with launchId", () => {
    expect(interpretButtonDisabled({ pending: false, launchId: "launch", sourceState: "waiting_input" })).toBe(true);
    expect(interpretButtonDisabled({ pending: false, launchId: "launch", attemptState: "waiting_input" })).toBe(true);
    expect(interpretButtonDisabled({ pending: false, launchId: "launch", jobState: "review" })).toBe(false);
    expect(interpretButtonDisabled({ pending: false, launchId: "launch", jobState: "canceled", attemptState: "awaiting_review" })).toBe(true);
  });

  it("requires an explicit version/hash and never first-of-many", () => {
    expect(resolveAcceptTarget([fileA, fileB], undefined).ok).toBe(false);
    expect(resolveAcceptTarget([fileA, fileB], undefined)).toEqual({ ok: false, reason: ACCEPT_AMBIGUOUS_NOTICE });
    expect(resolveAcceptTarget([fileA], "")).toEqual({ ok: false, reason: ACCEPT_NO_TARGET_NOTICE });
    expect(resolveAcceptTarget([fileA], fileA.id)).toEqual({ ok: false, reason: ACCEPT_NO_TARGET_NOTICE });
    expect(resolveAcceptTarget([fileA], acceptSelectionKey({ artifactId: fileA.id, version: 1, hash }))).toEqual({
      ok: true,
      target: { artifactId: fileA.id, version: 1, hash },
    });
    const v1 = acceptSelectionKey({ artifactId: fileA.id, version: 1, hash });
    const v2file = { ...fileA, version: 2, hash: "c".repeat(64) };
    expect(resolveAcceptTarget([v2file], v1)).toEqual({ ok: false, reason: ACCEPT_STALE_SELECTION_NOTICE });
  });

  it("does not present historical awaiting_review as current work on canceled jobs", () => {
    const assigned = { id: "agt_1", name: "Sonnet" };
    expect(currentWorkLabel({
      job: { state: "canceled", sourceState: "canceled" },
      assigned,
      attemptLabel: "Ожидает проверки",
    })).toBe(JOB_CANCELED_LABEL);
    expect(historicalAttemptNote({
      job: { state: "canceled" },
      assigned,
      attempt: { kind: "state", state: "awaiting_review" },
    })).toBe(`${LAST_LAUNCH_UNACCEPTED}: Sonnet · Ожидает проверки`);
    expect(currentWorkLabel({
      job: { state: "review" },
      assigned,
      attemptLabel: "Ожидает проверки",
    })).toBe("Sonnet · Ожидает проверки");
  });

  it("hides duplicate system role", () => {
    expect(activityRoleLabel("Система", "Система")).toBeUndefined();
    expect(activityRoleLabel("Анна", "Сотрудник")).toBe("Сотрудник");
  });
});
