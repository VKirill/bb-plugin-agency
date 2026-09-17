import { useEffect, useState } from "react";
import type { Job as JobRecord } from "../../shared/contracts";
import type { AgencyApi } from "../data/agency-api";
import type { WorkspaceSnapshot } from "../data/snapshot";
import { mapJobs } from "../data/view-models";
import type { Job } from "./data";

const PAGE = 500;
const MAX_PAGES = 20;

/**
 * Archived jobs are not in the workspace snapshot. When a job link points at a
 * key the board does not know, the archive is read once and mapped with the
 * same snapshot, so the card opens with its subtasks and department names.
 */
export function useArchivedJobs(api: Pick<AgencyApi, "listArchivedJobs">, snapshot: WorkspaceSnapshot, key: string | undefined, enabled: boolean): { jobs: Job[]; loading: boolean } {
  const [read, setRead] = useState<{ key: string; records: JobRecord[] } | null>(null);
  const records = read?.records ?? [];
  // Read again only for a key that the last read neither found nor was made for.
  const needed = enabled && Boolean(key) && !records.some((job) => job.key === key) && read?.key !== key;
  useEffect(() => {
    if (!needed || !key) return;
    let live = true;
    void (async () => {
      const found: JobRecord[] = [];
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const result = await api.listArchivedJobs({ limit: PAGE, offset: found.length });
        if (!result.ok) break;
        found.push(...result.value.jobs);
        if (!result.value.jobs.length || found.length >= result.value.total) break;
      }
      if (live) setRead({ key, records: found });
    })();
    return () => {
      live = false;
    };
  }, [api, key, needed]);
  if (!records.length) return { jobs: [], loading: needed };
  const archivedIds = new Set(records.map((job) => job.id));
  const jobs = mapJobs({ ...snapshot, jobs: [...snapshot.jobs, ...records] }).filter((job) => job.recordId && archivedIds.has(job.recordId));
  return { jobs, loading: needed };
}
