import { describe, expect, it } from "vitest";
import {
  HOST_UNKNOWN,
  ISOLATION_CONFIRMED,
  ISOLATION_UNCONFIRMED,
  ISOLATION_UNKNOWN,
  attemptsLabel,
  isolationLabel,
  jobEnvironmentEqual,
  jobHostLabel,
} from "../src/app/data/job-environment";
import { shortAgentName } from "../src/app/data/agent-name";
import { splitDescription } from "../src/app/data/view-models";

describe("job environment rail card", () => {
  it("does not claim isolation before the server answered", () => {
    expect(isolationLabel({ isolationReady: null, attempts: null })).toEqual({ text: ISOLATION_UNKNOWN, tone: "muted" });
  });

  it("marks proven isolation as confirmed", () => {
    expect(isolationLabel({ isolationReady: true, attempts: 2 })).toEqual({ text: ISOLATION_CONFIRMED, tone: "success" });
  });

  it("states unconfirmed isolation plainly", () => {
    expect(isolationLabel({ isolationReady: false, attempts: 0 }).text).toBe(ISOLATION_UNCONFIRMED);
  });

  it("shows a dash instead of guessing the attempt count", () => {
    expect(attemptsLabel({ isolationReady: true, attempts: null })).toBe("—");
    expect(attemptsLabel({ isolationReady: true, attempts: 0 })).toBe("0");
    expect(attemptsLabel({ isolationReady: true, attempts: 2 })).toBe("2");
  });

  it("names the host of the bound project", () => {
    const projects = [{ id: "bnd_one", hostName: "Mac mini" }, { id: "bnd_two", hostName: null }];
    expect(jobHostLabel("bnd_one", projects)).toBe("Mac mini");
    expect(jobHostLabel("bnd_two", projects)).toBe(HOST_UNKNOWN);
    expect(jobHostLabel(undefined, projects)).toBe(HOST_UNKNOWN);
  });

  it("compares statuses so the card does not re-render on equal reports", () => {
    expect(jobEnvironmentEqual({ isolationReady: true, attempts: 2 }, { isolationReady: true, attempts: 2 })).toBe(true);
    expect(jobEnvironmentEqual({ isolationReady: true, attempts: 2 }, { isolationReady: true, attempts: 3 })).toBe(false);
    expect(jobEnvironmentEqual({ isolationReady: null, attempts: 2 }, { isolationReady: false, attempts: 2 })).toBe(false);
  });
});

describe("short agent name", () => {
  it("drops the role prefix the rail label already carries", () => {
    expect(shortAgentName("Проверяющий — Opus")).toBe("Opus");
    expect(shortAgentName("Руководитель программистов — Fable")).toBe("Fable");
  });

  it("keeps names without a role prefix", () => {
    expect(shortAgentName("Анна")).toBe("Анна");
    expect(shortAgentName("")).toBe("");
    expect(shortAgentName(null)).toBe("");
  });
});

describe("split description", () => {
  it("separates the acceptance criteria the job actually carries", () => {
    const { brief, acceptance } = splitDescription("Сделать калькулятор\n\nКритерии приёмки:\n- Открывается\n- Считает");
    expect(brief).toBe("Сделать калькулятор");
    expect(acceptance).toBe("- Открывается\n- Считает");
  });

  it("returns no criteria when the job has none", () => {
    expect(splitDescription("Просто описание")).toEqual({ brief: "Просто описание", acceptance: null });
  });

  it("keeps an empty criteria block out of the card", () => {
    expect(splitDescription("Описание\n\nКритерии приёмки:\n   ").acceptance).toBeNull();
  });
});
