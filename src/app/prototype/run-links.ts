import { demoRuns } from "./demo/catalog";
import type { DemoRun } from "./data";

export type { DemoRun };
export const seedRuns = demoRuns;

export function runsForJob(jobId: string, runs: readonly DemoRun[] = seedRuns): DemoRun[] {
  return runs.filter(run => run.jobId === jobId);
}

export type RunRoute =
  | { kind: "list" }
  | { kind: "detail"; run: DemoRun }
  | { kind: "missing" };

export function resolveRunRoute(runId: string | undefined, runs: readonly DemoRun[] = seedRuns): RunRoute {
  if (!runId) return { kind: "list" };
  const run = runs.find(item => item.id === runId);
  return run ? { kind: "detail", run } : { kind: "missing" };
}
