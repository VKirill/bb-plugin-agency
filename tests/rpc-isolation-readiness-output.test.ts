import { describe, expect, it } from "vitest";
import type { z } from "zod";
import {
  domainResultSchema,
  isolationReadinessSchema,
  liveAssignedProviderSchema,
} from "../src/shared/rpc-contract";
import {
  resolveLiveAssignedProvider,
  type LiveAssignedProvider,
} from "../src/server/runtime/isolated-sdk/assigned-provider";

type Exact<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
  ? true
  : { expected: A; got: B };

/** Fails `tsc` if the live object and the host RPC schema drift — that is the AG-26 card error. */
const liveAssignedMatchesWire: Exact<LiveAssignedProvider, z.infer<typeof liveAssignedProviderSchema>> = true;
void liveAssignedMatchesWire;

const hostOutput = domainResultSchema(isolationReadinessSchema);

function store(rows: {
  agents: Array<{ id: string; currentVersionId: string }>;
  versions: Array<{ id: string; agentId: string; providerId: string; model: string }>;
}) {
  return {
    getAgent: (id: string) => rows.agents.find((item) => item.id === id),
    getAgentVersion: (id: string) => rows.versions.find((item) => item.id === id),
  } as Parameters<typeof resolveLiveAssignedProvider>[0];
}

function resolveReady(): LiveAssignedProvider {
  const resolved = resolveLiveAssignedProvider(
    store({
      agents: [{ id: "agent_aaaaaaaa", currentVersionId: "aver_aaaaaaaaaaa" }],
      versions: [{
        id: "aver_aaaaaaaaaaa",
        agentId: "agent_aaaaaaaa",
        providerId: "claude-code",
        model: "claude-fable-5-1",
      }],
    }),
    { id: "job_aaaaaaaaaaaa", assignedAgentId: "agent_aaaaaaaa" },
  );
  expect(resolved.ok).toBe(true);
  if (!resolved.ok) throw new Error("expected assigned provider");
  return resolved.value;
}

describe("getIsolationReadiness host output", () => {
  it("parses the live assigned provider the same way the host validates RPC", () => {
    const assigned = resolveReady();
    liveAssignedProviderSchema.parse(assigned);
    const parsed = hostOutput.parse({
      ok: true,
      value: {
        executionAvailable: true,
        isolationReady: true,
        assignedProvider: assigned,
        launchAllowedForAssigned: false,
        reason: "Сотрудник приостановлен.",
        reasonCode: "launch_not_authorized",
      },
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.assignedProvider?.model).toBe("claude-fable-5-1");
  });

  it("rejects an extra key the way the host does", () => {
    const assigned = resolveReady();
    expect(liveAssignedProviderSchema.safeParse({ ...assigned, extra: "no" }).success).toBe(false);
  });
});
