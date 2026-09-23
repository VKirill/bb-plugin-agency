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
      ? `${key}: loop stop (${bits}). The department lead must diagnose and repair the cause before another pass. A verified job recover authorizes one continuation; later new evidence can also lift the mark.`
      : `${key}: стоп круга (${bits}). Руководитель отдела должен разобрать и устранить причину до повтора. Проверенный job recover разрешает одно продолжение; новая улика также может снять метку.`;
  recordOwnerMessage(
    db,
    { text, level: "warning", jobId: rootId, dedupeKey: `loop-blocked:${rootId}:${bits}` },
    "loop-break",
    now,
  );
}
