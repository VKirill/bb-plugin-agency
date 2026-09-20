export type SpecGateReason = "no_spec_job" | "spec_not_accepted" | "spec_not_linked";

export interface SpecGateVersionRef {
  artifactId: string;
  version: number;
  hash: string;
}

export interface SpecGateInput {
  rootWorkKind: string | null;
  jobDepartmentId: string;
  specDepartmentId: string | null;
  gatedDepartmentIds: readonly string[];
  specJobs: readonly { id: string; state: string; accepted: readonly SpecGateVersionRef[] }[];
  inputs: readonly (SpecGateVersionRef & { sourceJobId: string })[];
  waitsFor: readonly string[];
}

export type SpecGateResult =
  | { required: false }
  | { required: true; satisfied: true; specJobId: string }
  | { required: true; satisfied: false; reason: SpecGateReason };

function sameVersion(left: SpecGateVersionRef, right: SpecGateVersionRef): boolean {
  return left.artifactId === right.artifactId && left.version === right.version && left.hash === right.hash;
}

function isAcceptedSpecJob(job: { state: string; accepted: readonly SpecGateVersionRef[] }): boolean {
  return job.state === "done" && job.accepted.length > 0;
}

export function evaluateSpecGate(input: SpecGateInput): SpecGateResult {
  if (
    input.rootWorkKind !== "new-program" ||
    input.specDepartmentId === null ||
    !input.gatedDepartmentIds.includes(input.jobDepartmentId) ||
    input.jobDepartmentId === input.specDepartmentId
  ) {
    return { required: false };
  }

  const liveSpecJobs = input.specJobs.filter((job) => job.state !== "canceled");
  if (liveSpecJobs.length === 0) {
    return { required: true, satisfied: false, reason: "no_spec_job" };
  }

  const acceptedSpecJobs = liveSpecJobs.filter(isAcceptedSpecJob);
  if (acceptedSpecJobs.length === 0) {
    return { required: true, satisfied: false, reason: "spec_not_accepted" };
  }

  for (const specJob of acceptedSpecJobs) {
    if (input.waitsFor.includes(specJob.id)) {
      return { required: true, satisfied: true, specJobId: specJob.id };
    }
    const linked = input.inputs.some(
      (row) =>
        row.sourceJobId === specJob.id && specJob.accepted.some((accepted) => sameVersion(row, accepted)),
    );
    if (linked) {
      return { required: true, satisfied: true, specJobId: specJob.id };
    }
  }

  return { required: true, satisfied: false, reason: "spec_not_linked" };
}
