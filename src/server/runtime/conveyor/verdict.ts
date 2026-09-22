import type { SqlDatabase } from "../../db/sql";

/** A missing or malformed decision is never an acceptance. Shared by QC and loop-break. */
export type ReviewVerdict = "accept" | "rework" | "inconclusive";

function explicitVerdict(text: string): ReviewVerdict | null {
  const plain = text.slice(0, 8000).replace(/\*\*|__/g, "");
  const line = /(?:вердикт|verdict)[\s:：—–-]*(принять|accept|доработать|rework|return|inconclusive|не проверено)(?=$|[\s.,;!?])/i.exec(plain);
  if (!line) return null;
  const token = line[1]!.toLowerCase();
  if (token === "принять" || token === "accept") return "accept";
  if (token === "доработать" || token === "rework" || token === "return") return "rework";
  return "inconclusive";
}

export function parseReviewVerdict(text: string): ReviewVerdict {
  return explicitVerdict(text) ?? "inconclusive";
}

/** Only a decision for the latest published report; later system notes cannot overwrite it. */
export function latestReviewText(db: SqlDatabase, jobId: string): string {
  const rows = db.prepare(`SELECT comment FROM agency_activity
    WHERE job_id = ? AND kind = 'comment' AND comment IS NOT NULL
      AND rowid > COALESCE((SELECT MAX(rowid) FROM agency_activity WHERE job_id = ? AND kind = 'artifact_published'), 0)
    ORDER BY rowid DESC`).all(jobId, jobId) as Array<{ comment: string }>;
  return rows.find(row => explicitVerdict(row.comment) !== null)?.comment ?? "";
}
