import { describe, expect, it } from "vitest";
import { isolationReadinessSchema, publicLaunchReasonCode } from "../src/shared/rpc-contract";

describe("public launch reason codes", () => {
  it("maps assignee, handshake, and isolation to stable codes", () => {
    expect(
      publicLaunchReasonCode({
        assignedErrorCode: "assignee_required",
        handshakeReady: true,
        sdkTypedSpawnReady: true,
        launchAllowed: false,
        hasJobId: true,
      }),
    ).toBe("assignee_required");
    expect(
      publicLaunchReasonCode({
        assignedErrorCode: "assignee_not_member",
        handshakeReady: true,
        sdkTypedSpawnReady: true,
        launchAllowed: false,
        hasJobId: true,
      }),
    ).toBe("assignee_not_member");
    expect(
      publicLaunchReasonCode({
        assignedErrorCode: "provider_isolation_unproven",
        handshakeReady: true,
        sdkTypedSpawnReady: true,
        launchAllowed: false,
        hasJobId: true,
      }),
    ).toBe("isolation_unproven");
    expect(
      publicLaunchReasonCode({
        handshakeReady: false,
        sdkTypedSpawnReady: true,
        launchAllowed: false,
        hasJobId: true,
      }),
    ).toBe("handshake_unready");
    expect(
      publicLaunchReasonCode({
        handshakeReady: true,
        sdkTypedSpawnReady: false,
        launchAllowed: false,
        hasJobId: true,
      }),
    ).toBe("handshake_unready");
    expect(
      publicLaunchReasonCode({
        handshakeReady: true,
        sdkTypedSpawnReady: true,
        launchAllowed: false,
        hasJobId: false,
      }),
    ).toBe("launch_not_authorized");
    expect(
      publicLaunchReasonCode({
        handshakeReady: true,
        sdkTypedSpawnReady: true,
        launchAllowed: true,
        hasJobId: true,
      }),
    ).toBe("ok");
  });

  it("keeps English reason technical next to reasonCode on the wire schema", () => {
    const parsed = isolationReadinessSchema.parse({
      handshakeReady: false,
      executionAvailable: false,
      isolationReady: false,
      isolatedSpawnFields: false,
      sdkTypedSpawnReady: true,
      provenIsolationProviders: ["claude-code"],
      assignedProvider: null,
      launchAllowedForAssigned: false,
      reason: "typed runtime capability handshake is not proven; TypeScript types and instance names are not evidence",
      reasonCode: "handshake_unready",
    });
    expect(parsed.reasonCode).toBe("handshake_unready");
    expect(parsed.reason).toMatch(/handshake is not proven/);
  });
});
