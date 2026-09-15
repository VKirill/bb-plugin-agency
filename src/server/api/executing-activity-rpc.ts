import type { IsolatedThreadsApi } from "../runtime/isolated-sdk/sdk-ports.js";
import {
  countExecutingJobs,
  countInProgressJobs,
  listBoundExecutingCandidates,
  listRunningJobIds,
} from "../runtime/executing-activity/index.js";
import type { SqlDatabase } from "../db/sql.js";

export function createExecutingActivityRpc(deps: {
  db: SqlDatabase;
  threads: IsolatedThreadsApi;
}) {
  return {
    sidebarExecutingJobCount() {
      return countExecutingJobs({
        listCandidates: () => listBoundExecutingCandidates(deps.db),
        getThread: (threadId) => deps.threads.get({ threadId }),
      });
    },
    sidebarInProgressJobCount() {
      return countInProgressJobs({
        listRunningJobIds: () => listRunningJobIds(deps.db),
      });
    },
  };
}
