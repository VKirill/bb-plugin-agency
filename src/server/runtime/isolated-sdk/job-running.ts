import { fail, ok, type DomainResult } from "../../../domain";
import type { DomainStore, ServiceContext } from "../../services";
import { uuidV5 } from "../launch/operation-ids.js";
import type { JobRunningPort } from "../launch/ports.js";

export function createStoreJobRunningPort(store: DomainStore): JobRunningPort {
  return {
    async onConfirmedBind(ctx: ServiceContext, bind): Promise<DomainResult<true>> {
      const job = store.getJob(bind.jobId);
      if (!job) return fail("not_found", `job ${bind.jobId} not found`);
      const facts = store.setJobExecutionFacts(ctx, {
        requestId: uuidV5(bind.launchId, "agency.job.facts"),
        jobId: bind.jobId,
        threadBound: true,
      });
      if (!facts.ok) return facts;
      let current = store.getJob(bind.jobId);
      if (!current) return fail("not_found", `job ${bind.jobId} not found`);
      if (current.state === "running") return ok(true);
      if (current.state === "backlog") {
        const queued = store.transitionJob(ctx, {
          requestId: uuidV5(bind.launchId, "agency.job.queued"),
          jobId: bind.jobId,
          expectedRevision: current.revision,
          to: "queued",
        });
        if (!queued.ok) return queued;
        current = queued.value;
      }
      if (current.state !== "queued") {
        return fail("illegal_job_state", `confirmed bind cannot set running from ${current.state}`);
      }
      const running = store.transitionJob(ctx, {
        requestId: uuidV5(bind.launchId, "agency.job.running"),
        jobId: bind.jobId,
        expectedRevision: current.revision,
        to: "running",
      });
      if (!running.ok) return running;
      return ok(true);
    },
  };
}
