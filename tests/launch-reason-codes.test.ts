import { describe, expect, it } from "vitest";
import { isolationReadinessSchema, publicLaunchReasonCode } from "../src/shared/rpc-contract";

describe("public launch reason codes", () => {
  it("maps assignee and authorization to stable codes; there is no handshake code", () => {
    expect(
      publicLaunchReasonCode({
        assignedErrorCode: "assignee_required",
        launchAllowed: false,
        hasJobId: true,
      }),
    ).toBe("assignee_required");
    expect(
      publicLaunchReasonCode({
        assignedErrorCode: "assignee_not_member",
        launchAllowed: false,
        hasJobId: true,
      }),
    ).toBe("assignee_not_member");
    expect(
      publicLaunchReasonCode({
        assignedErrorCode: "provider_unavailable",
        launchAllowed: false,
        hasJobId: true,
      }),
    ).toBe("launch_not_authorized");
    expect(
      publicLaunchReasonCode({
        launchAllowed: false,
        hasJobId: false,
      }),
    ).toBe("launch_not_authorized");
    expect(
      publicLaunchReasonCode({
        launchAllowed: true,
        hasJobId: true,
      }),
    ).toBe("ok");
  });

  it("keeps English reason technical next to reasonCode on the wire schema", () => {
    const parsed = isolationReadinessSchema.parse({
      executionAvailable: true,
      isolationReady: true,
      assignedProvider: null,
      launchAllowedForAssigned: false,
      reason: "getIsolationReadiness without jobId does not authorize a launch",
      reasonCode: "launch_not_authorized",
    });
    expect(parsed.reasonCode).toBe("launch_not_authorized");
    expect(parsed.reason).toMatch(/does not authorize a launch/);
    expect(isolationReadinessSchema.safeParse({ ...parsed, reasonCode: "handshake_unready" }).success).toBe(false);
    expect(isolationReadinessSchema.safeParse({ ...parsed, handshakeReady: true }).success).toBe(false);
  });

  it("accepts the live assigned provider payload with model", () => {
    const parsed = isolationReadinessSchema.parse({
      executionAvailable: true,
      isolationReady: true,
      assignedProvider: {
        jobId: "job_d0d7cff575c6f52f6005b0c6",
        agentId: "agt_a50f169377d8eebd6f37a36f",
        agentVersionId: "avr_28ec5d9200c1f0fd5a416903",
        providerId: "claude-code",
        model: "claude-fable-5-1",
        source: "live_assigned_agent_version",
      },
      launchAllowedForAssigned: false,
      reason: "Сотрудник приостановлен.",
      reasonCode: "launch_not_authorized",
    });
    expect(parsed.assignedProvider?.model).toBe("claude-fable-5-1");
  });
});
