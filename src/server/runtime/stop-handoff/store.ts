import { createRepositories } from "../../db/repositories.js";
import { toJson, type SqlDatabase } from "../../db/sql.js";
import { parseStopIntentRecord } from "./parse.js";
import type { StopHandoffStore } from "./ports.js";
import { STOP_HANDOFF_KIND, type StopIntentRecord } from "./types.js";

function readStoredResult(raw: string): StopIntentRecord | undefined {
  try {
    return parseStopIntentRecord(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

export function createStopHandoffStore(db: SqlDatabase): StopHandoffStore {
  const repos = createRepositories(db);

  function listKind(): StopIntentRecord[] {
    const rows = db
      .prepare(`SELECT result_json FROM agency_request WHERE kind = ?`)
      .all(STOP_HANDOFF_KIND) as Array<{ result_json: string }>;
    const out: StopIntentRecord[] = [];
    for (const row of rows) {
      const parsed = readStoredResult(row.result_json);
      if (parsed) out.push(parsed);
    }
    return out;
  }

  return {
    getByRequestId(requestId: string): StopIntentRecord | undefined {
      const existing = repos.request.get(requestId);
      if (!existing || existing.kind !== STOP_HANDOFF_KIND) return undefined;
      return parseStopIntentRecord(existing.result);
    },
    listByJob(jobId: string): readonly StopIntentRecord[] {
      return listKind().filter((row) => row.jobId === jobId);
    },
    listByAttempt(attemptId: string): readonly StopIntentRecord[] {
      return listKind().filter((row) => row.attemptId === attemptId);
    },
    insert(record: StopIntentRecord, actor: unknown, scopeBindingIds: readonly string[]): void {
      repos.request.insert(
        record.requestId,
        STOP_HANDOFF_KIND,
        record,
        {
          jobId: record.jobId,
          attemptId: record.attemptId,
          launchId: record.launchId,
          threadId: record.threadId,
        },
        actor,
        scopeBindingIds,
        record.createdAt,
      );
    },
    update(record: StopIntentRecord): void {
      db.prepare(`UPDATE agency_request SET result_json = ? WHERE request_id = ? AND kind = ?`).run(
        toJson(record),
        record.requestId,
        STOP_HANDOFF_KIND,
      );
    },
  };
}
