import { agencyLanguage } from "../../i18n/language.js";
import type { SqlDatabase } from "../../db/sql";
import { recordOwnerMessage } from "../../owner-messages/service.js";
import { loopEffect } from "./mark.js";
import { latestLoopMark } from "./store.js";

/** The hard stop is the mark. This only tells the owner once per mark, in Inbox. */
export function announceLoopBlock(db: SqlDatabase, rootId: string, now = new Date().toISOString()): void {
  if (!db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'agency_owner_message'`).get()) return;
  const mark = latestLoopMark(db, rootId);
  if (!mark || loopEffect(mark) !== "block") return;
  const job = db.prepare(`SELECT key FROM agency_job WHERE id = ?`).get(rootId) as { key: string } | undefined;
  const bits = [mark.relation, mark.cause].filter(Boolean).join("/") || "block";
  const key = job?.key ?? rootId;
  const text =
    agencyLanguage() === "en"
      ? `${key}: loop stop (${bits}). The server will not open another station and will not retry the same thread. A later new_evidence mark lifts it. Otherwise close the line.`
      : `${key}: стоп круга (${bits}). Сервер не откроет новую станцию и не повторит тот же тред. Снимает это только более поздняя метка new_evidence. Иначе закройте линию.`;
  recordOwnerMessage(
    db,
    { text, level: "warning", jobId: rootId, dedupeKey: `loop-blocked:${rootId}:${bits}` },
    "loop-break",
    now,
  );
}
