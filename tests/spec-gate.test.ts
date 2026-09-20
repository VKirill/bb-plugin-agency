import { describe, expect, it } from "vitest";
import {
  evaluateSpecGate,
  type SpecGateInput,
  type SpecGateVersionRef,
} from "../src/domain/spec-gate";

const SPEC_DEP = "dep_product01";
const DEV_DEP = "dep_develop01";
const DESIGN_DEP = "dep_design01";
const SPEC_JOB = "job_spec0001";
const SPEC_JOB_B = "job_spec0002";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

const acceptedA: SpecGateVersionRef = {
  artifactId: "art_spec0001",
  version: 1,
  hash: HASH_A,
};

function gated(overrides: Partial<SpecGateInput> = {}): SpecGateInput {
  return {
    rootWorkKind: "new-program",
    jobDepartmentId: DEV_DEP,
    specDepartmentId: SPEC_DEP,
    gatedDepartmentIds: [DEV_DEP, DESIGN_DEP],
    specJobs: [],
    inputs: [],
    waitsFor: [],
    ...overrides,
  };
}

describe("evaluateSpecGate", () => {
  it("does not require a spec when the root work kind is not new-program", () => {
    expect(evaluateSpecGate(gated({ rootWorkKind: "feature" }))).toEqual({ required: false });
    expect(evaluateSpecGate(gated({ rootWorkKind: null }))).toEqual({ required: false });
  });

  it("does not require a spec when the spec department is unset", () => {
    expect(evaluateSpecGate(gated({ specDepartmentId: null }))).toEqual({ required: false });
  });

  it("does not require a spec when the job department is outside the gated list", () => {
    expect(evaluateSpecGate(gated({ jobDepartmentId: "dep_office01" }))).toEqual({ required: false });
  });

  it("does not require a spec when the job already belongs to the spec department", () => {
    expect(evaluateSpecGate(gated({ jobDepartmentId: SPEC_DEP }))).toEqual({ required: false });
  });

  it("reports no_spec_job when there is no live spec job", () => {
    expect(evaluateSpecGate(gated())).toEqual({
      required: true,
      satisfied: false,
      reason: "no_spec_job",
    });
  });

  it("reports spec_not_accepted when no live spec job is done with an accepted version", () => {
    expect(
      evaluateSpecGate(
        gated({
          specJobs: [{ id: SPEC_JOB, state: "review", accepted: [acceptedA] }],
        }),
      ),
    ).toEqual({ required: true, satisfied: false, reason: "spec_not_accepted" });
    expect(
      evaluateSpecGate(
        gated({
          specJobs: [{ id: SPEC_JOB, state: "done", accepted: [] }],
        }),
      ),
    ).toEqual({ required: true, satisfied: false, reason: "spec_not_accepted" });
  });

  it("is satisfied when waitsFor points at an accepted spec job", () => {
    expect(
      evaluateSpecGate(
        gated({
          specJobs: [{ id: SPEC_JOB, state: "done", accepted: [acceptedA] }],
          waitsFor: [SPEC_JOB],
        }),
      ),
    ).toEqual({ required: true, satisfied: true, specJobId: SPEC_JOB });
  });

  it("is satisfied when an input matches an accepted spec version", () => {
    expect(
      evaluateSpecGate(
        gated({
          specJobs: [{ id: SPEC_JOB, state: "done", accepted: [acceptedA] }],
          inputs: [{ sourceJobId: SPEC_JOB, ...acceptedA }],
        }),
      ),
    ).toEqual({ required: true, satisfied: true, specJobId: SPEC_JOB });
  });

  it("reports spec_not_linked when an accepted spec exists but is not attached", () => {
    expect(
      evaluateSpecGate(
        gated({
          specJobs: [{ id: SPEC_JOB, state: "done", accepted: [acceptedA] }],
        }),
      ),
    ).toEqual({ required: true, satisfied: false, reason: "spec_not_linked" });
  });

  it("does not treat an input with a different hash as a link", () => {
    expect(
      evaluateSpecGate(
        gated({
          specJobs: [{ id: SPEC_JOB, state: "done", accepted: [acceptedA] }],
          inputs: [{ sourceJobId: SPEC_JOB, artifactId: acceptedA.artifactId, version: 1, hash: HASH_B }],
        }),
      ),
    ).toEqual({ required: true, satisfied: false, reason: "spec_not_linked" });
  });

  it("ignores a canceled spec job even if it has an accepted version", () => {
    expect(
      evaluateSpecGate(
        gated({
          specJobs: [{ id: SPEC_JOB, state: "canceled", accepted: [acceptedA] }],
        }),
      ),
    ).toEqual({ required: true, satisfied: false, reason: "no_spec_job" });
  });

  it("is satisfied when one of two spec jobs is accepted and linked", () => {
    expect(
      evaluateSpecGate(
        gated({
          specJobs: [
            { id: SPEC_JOB, state: "running", accepted: [] },
            { id: SPEC_JOB_B, state: "done", accepted: [acceptedA] },
          ],
          waitsFor: [SPEC_JOB_B],
        }),
      ),
    ).toEqual({ required: true, satisfied: true, specJobId: SPEC_JOB_B });
  });
});
