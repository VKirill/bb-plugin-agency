import { describe, expect, it } from "vitest";
import { resolveLiveAssignedProvider } from "../src/server/runtime/isolated-sdk/assigned-provider";

function store(rows: {
  agents: Array<{ id: string; currentVersionId: string }>;
  versions: Array<{ id: string; agentId: string; providerId: string; model?: string }>;
}) {
  return {
    getAgent: (id: string) => rows.agents.find((item) => item.id === id),
    getAgentVersion: (id: string) => rows.versions.find((item) => item.id === id),
  } as Parameters<typeof resolveLiveAssignedProvider>[0];
}

describe("live assigned provider", () => {
  it("reads current agentVersion.providerId and model, not a caller guess", () => {
    const resolved = resolveLiveAssignedProvider(
      store({
        agents: [{ id: "agent_aaaaaaaa", currentVersionId: "aver_aaaaaaaaaaa" }],
        versions: [{
          id: "aver_aaaaaaaaaaa",
          agentId: "agent_aaaaaaaa",
          providerId: "codex",
          model: "gpt-5.4",
        }],
      }),
      { id: "job_aaaaaaaaaaaa", assignedAgentId: "agent_aaaaaaaa" },
    );
    expect(resolved).toEqual({
      ok: true,
      value: {
        jobId: "job_aaaaaaaaaaaa",
        agentId: "agent_aaaaaaaa",
        agentVersionId: "aver_aaaaaaaaaaa",
        providerId: "codex",
        model: "gpt-5.4",
        source: "live_assigned_agent_version",
      },
    });
  });

  it("fails closed without a model", () => {
    expect(resolveLiveAssignedProvider(
      store({
        agents: [{ id: "agent_aaaaaaaa", currentVersionId: "aver_aaaaaaaaaaa" }],
        versions: [{ id: "aver_aaaaaaaaaaa", agentId: "agent_aaaaaaaa", providerId: "codex", model: "" }],
      }),
      { id: "job_aaaaaaaaaaaa", assignedAgentId: "agent_aaaaaaaa" },
    ).ok).toBe(false);
  });

  it("fails closed without assignee", () => {
    expect(resolveLiveAssignedProvider(store({ agents: [], versions: [] }), {
      id: "job_aaaaaaaaaaaa",
      assignedAgentId: null,
    }).ok).toBe(false);
  });

  it("can overlay the owner-set reserve without rewriting the stored version id", () => {
    const resolved = resolveLiveAssignedProvider(
      store({
        agents: [{ id: "agent_aaaaaaaa", currentVersionId: "aver_aaaaaaaaaaa" }],
        versions: [{
          id: "aver_aaaaaaaaaaa",
          agentId: "agent_aaaaaaaa",
          providerId: "codex",
          model: "gpt-5.4",
        }],
      }),
      { id: "job_aaaaaaaaaaaa", assignedAgentId: "agent_aaaaaaaa" },
      {
        effectiveVersion: (version) => ({
          ...version,
          providerId: "opencode",
          model: "gemini-3.8-flash",
        }),
      },
    );
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.value.agentVersionId).toBe("aver_aaaaaaaaaaa");
      expect(resolved.value.providerId).toBe("opencode");
      expect(resolved.value.model).toBe("gemini-3.8-flash");
    }
  });
});
