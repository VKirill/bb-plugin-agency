import { describe, expect, it, vi } from "vitest";
import { assessVerification } from "../src/server/decisions/verification-advice";
import { DEFAULT_DECISION_SETTINGS } from "../src/shared/decisions";
import { verificationAdviceInputSchema } from "../src/shared/contracts/verification-advice";
const settings = { ...DEFAULT_DECISION_SETTINGS, enabled: true, endpointKind: "typesafe" as const, model: "jev-latest", points: ["verification-advice"] };
const job = { title: "Update help text", brief: "Fix the README wording", acceptance: "Accurate instructions; final checks before delivery" };
const input = { jobId: "job_12345678", phase: "implementation" as const, diff: "- old\n+ new", changedPaths: ["README.md"], completeDiff: true, knownFailure: false, requiredNow: false };
function response(choice: string, confidence: number) {
 return vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ answers: { timing: { choice, confidence } } }), { status: 200 }));
}
describe("verification advice", () => {
 it.each([
  [{ phase: "final" }, "final_checks"], [{ knownFailure: true }, "targeted_now"],
  [{ requiredNow: true }, "targeted_now"], [{ completeDiff: false }, "review_required"],
  [{ changedPaths: ["src/migrations/004.sql"] }, "targeted_now"],
  [{ changedPaths: ["src\\auth\\login.ts"] }, "targeted_now"],
 ] as const)("applies deterministic boundary %j before inference", async (change, action) => {
  const fetch = response("defer", 1); const actual = await assessVerification(settings, job, { ...input, ...change, changedPaths: [...(("changedPaths" in change ? change.changedPaths : input.changedPaths))] }, { fetch, key: "fixture" });
  expect(actual).toMatchObject({ action, finalChecksRequired: true, advisory: true, model: null }); expect(fetch).not.toHaveBeenCalled();
 });
 it("sends the complete evidence and only defers intermediate work, never grants acceptance", async () => {
  const fetch = response("defer", 0.99); const full = { ...input, diff: "change\n".repeat(9000) + "LAST_CHANGE" };
  const actual = await assessVerification(settings, job, full, { fetch, key: "fixture" });
  const sent = JSON.parse(String(fetch.mock.calls[0]![1]!.body));
  expect(JSON.parse(sent.state)).toEqual({ job, change: full }); expect(actual.inputBytes).toBe(Buffer.byteLength(sent.state));
  expect(actual).toMatchObject({ action: "defer_to_final", finalChecksRequired: true, advisory: true });
  const changed = await assessVerification(settings, job, { ...full, diff: full.diff + "changed" }, { fetch, key: "fixture" });
  expect(changed.inputHash).not.toBe(actual.inputHash);
 });
 it.each([["defer",0.89,"review_required"],["targeted",0.91,"targeted_now"],["uncertain",0.99,"review_required"],["defer",1.5,"review_required"]])("routes %s/%s without assuming code correctness", async (choice, confidence, action) => {
  const actual = await assessVerification(settings, job, input, { fetch: response(String(choice), Number(confidence)), key: "fixture" });
  expect(actual.action).toBe(action); expect(actual.finalChecksRequired).toBe(true);
 });
 it("keeps outages and disabled evaluators from becoming permission to skip", async () => {
  const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new Error("offline"));
  expect((await assessVerification(settings, job, input, { fetch, key: "fixture" })).action).toBe("review_required");
  fetch.mockClear(); expect((await assessVerification({ ...settings, enabled: false }, job, input, { fetch })).reason).toBe("evaluator_disabled"); expect(fetch).not.toHaveBeenCalled();
 });
 it("requires explicit evidence completeness, failures and checkpoint status", () => {
  expect(verificationAdviceInputSchema.safeParse({ jobId: input.jobId, diff: input.diff }).success).toBe(false);
 });
});
