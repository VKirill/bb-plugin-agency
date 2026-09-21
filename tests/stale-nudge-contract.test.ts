import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { resolveAlias } from "../src/server/cli/aliases";
import { CLI_EXAMPLES } from "../src/server/cli/examples";
import { CLI_OPERATIONS } from "../src/server/cli/operations";
import { schemaDocument } from "../src/server/cli/schema-help";
import {
  STALE_ANSWER_REFUSAL_CODES,
  STALE_OUTCOME_CODE,
  batchId,
  nudgeId,
  staleAnswerSchema,
  staleBatchToken,
  staleNudgeToken,
} from "../src/shared/contracts/stale-nudge";
import { rpcContract, staleAnswerRpc, staleAnswerRpcSchema } from "../src/shared/rpc-contract";

const REQUEST_ID = "11111111-1111-4111-8111-111111111111";

function base(over: Record<string, unknown> = {}) {
  return {
    requestId: REQUEST_ID,
    jobId: "job_aaaaaaaaaaaa",
    nudgeId: "stale:job_aaaaaaaaaaaa:2026-09-21T00:00:00.000Z:1",
    expectedJobRevision: 12,
    decision: "cancel",
    reason: "Тест маршрута закрыт.",
    ...over,
  };
}

describe("stale-nudge contract", () => {
  it("builds ids and tokens from the spec formats", () => {
    const id = nudgeId("job_aaaaaaaaaaaa", "2026-09-21T00:00:00.000Z", 2);
    expect(id).toBe("stale:job_aaaaaaaaaaaa:2026-09-21T00:00:00.000Z:2");
    expect(staleNudgeToken(id)).toBe(`agency.staleNudge:${id}`);
    const claimed = new Date("2026-09-21T12:00:00.000Z");
    const batch = batchId("thr_origin01", claimed);
    expect(batch).toBe("stalebatch:thr_origin01:1789992000");
    expect(staleBatchToken(batch)).toBe(`agency.staleBatch:${batch}`);
  });

  it("requires expectedJobRevision and a non-empty reason", () => {
    const { expectedJobRevision: _, ...withoutRevision } = base();
    expect(staleAnswerSchema.safeParse(withoutRevision).success).toBe(false);
    expect(staleAnswerSchema.safeParse(base({ reason: "" })).success).toBe(false);
    expect(staleAnswerSchema.safeParse(base({ reason: "   " })).success).toBe(false);
    expect(staleAnswerSchema.safeParse(base()).success).toBe(true);
  });

  it("accepts nextCheckHours only for keep and only in 1–168", () => {
    expect(staleAnswerSchema.safeParse(base({ decision: "keep", nextCheckHours: 24 })).success).toBe(true);
    expect(staleAnswerSchema.safeParse(base({ decision: "keep" })).success).toBe(false);
    expect(staleAnswerSchema.safeParse(base({ decision: "keep", nextCheckHours: 0 })).success).toBe(false);
    expect(staleAnswerSchema.safeParse(base({ decision: "keep", nextCheckHours: 169 })).success).toBe(false);
    expect(staleAnswerSchema.safeParse(base({ decision: "cancel", nextCheckHours: 24 })).success).toBe(false);
    expect(staleAnswerSchema.safeParse(base({ decision: "close", nextCheckHours: 12 })).success).toBe(false);
  });

  it("does not introduce resolved_elsewhere", () => {
    expect(STALE_OUTCOME_CODE).toBe("closed_by_origin_agent");
    expect(STALE_ANSWER_REFUSAL_CODES).not.toContain("resolved_elsewhere");
    expect(JSON.stringify(STALE_ANSWER_REFUSAL_CODES)).not.toContain("resolved_elsewhere");
    const contract = readFileSync(new URL("../src/shared/contracts/stale-nudge.ts", import.meta.url), "utf8");
    const rpc = readFileSync(new URL("../src/shared/rpc-contract.ts", import.meta.url), "utf8");
    expect(contract).not.toContain("resolved_elsewhere");
    expect(rpc).not.toContain("resolved_elsewhere");
  });

  it("exposes CLI job stale-answer and a schema example with expectedJobRevision", () => {
    expect(resolveAlias(["job", "stale-answer"])).toBe("staleAnswer");
    expect(CLI_OPERATIONS.staleAnswer.input).toBe(staleAnswerRpcSchema);
    expect(staleAnswerRpc.input).toBe(staleAnswerRpcSchema);
    expect(rpcContract.staleAnswer).toBe(staleAnswerRpc);
    const example = CLI_EXAMPLES.staleAnswer as { expectedJobRevision: number };
    expect(example.expectedJobRevision).toBe(12);
    expect(CLI_OPERATIONS.staleAnswer.input.safeParse(example).success).toBe(true);
    expect(schemaDocument("staleAnswer").example).toEqual(CLI_EXAMPLES.staleAnswer);
  });
});
