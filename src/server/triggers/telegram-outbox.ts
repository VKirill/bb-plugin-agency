import type { SqlDatabase } from "../db/sql";

/**
 * Telegram queue. Main jobs that wait for the owner — review, a question,
 * «needs decision», done — are delivered once per state change to the Telegram
 * Projects topic of their BB project, when the owner turned it on in
 * «Настройки → Подключения». Only the key, title and state leave BB; answers
 * and forms stay in BB.
 */

export const TELEGRAM_OUTBOX_MIGRATION = `CREATE TABLE agency_telegram_delivery (
    delivery_id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    state TEXT NOT NULL,
    error TEXT,
    created_at TEXT NOT NULL
  )`;

/** Only recent changes are sent: turning the bridge on does not replay history. */
export const TELEGRAM_RECENT_MS = 24 * 60 * 60 * 1000;

// Review is a station of the line, not a wait for the customer: it is never sent.
const STATE_LABEL: Record<string, string> = {
  waiting_input: "ждёт вашего ответа",
  blocked: "ожидает решения",
  done: "готово",
};

export type TelegramPreference = { enabled: boolean; projectId: string; notifications: boolean; questions: boolean };

export type TelegramOutboxPorts = {
  db: SqlDatabase;
  preferences: () => Promise<TelegramPreference>;
  enqueue: (input: { deliveryId: string; projectId: string; jobId: string; title: string; kind: "notification" | "question_link" }) => Promise<unknown>;
  now: () => Date;
};

export async function sweepTelegramOutbox(ports: TelegramOutboxPorts): Promise<number> {
  const pref = await ports.preferences();
  if (!pref.enabled || !pref.projectId) return 0;
  const since = new Date(ports.now().getTime() - TELEGRAM_RECENT_MS).toISOString();
  const jobs = ports.db
    .prepare(
      `SELECT j.id, j.key, j.title, j.state, j.revision FROM agency_job j
       JOIN agency_project_binding b ON b.id = j.binding_id
       WHERE j.parent_job_id IS NULL AND j.state IN ('waiting_input', 'blocked', 'done')
         AND b.bb_project_id = ? AND j.updated_at >= ?`,
    )
    .all(pref.projectId, since) as { id: string; key: string; title: string; state: string; revision: number }[];
  let sent = 0;
  for (const job of jobs) {
    const kind = job.state === "waiting_input" ? "question_link" : "notification";
    if (kind === "notification" ? !pref.notifications : !pref.questions) continue;
    const deliveryId = `agency:${job.id}:${job.state}:${job.revision}`;
    const claimed = ports.db
      .prepare(`INSERT OR IGNORE INTO agency_telegram_delivery (delivery_id, job_id, kind, state, error, created_at) VALUES (?, ?, ?, 'pending', NULL, ?)`)
      .run(deliveryId, job.id, kind, ports.now().toISOString());
    if (claimed.changes === 0) continue;
    try {
      await ports.enqueue({ deliveryId, projectId: pref.projectId, jobId: job.id, title: `${job.key}: ${job.title} — ${STATE_LABEL[job.state] ?? job.state}`.slice(0, 300), kind });
      ports.db.prepare(`UPDATE agency_telegram_delivery SET state = 'queued' WHERE delivery_id = ?`).run(deliveryId);
      sent += 1;
    } catch (error) {
      ports.db.prepare(`UPDATE agency_telegram_delivery SET state = 'failed', error = ? WHERE delivery_id = ?`).run(String(error).slice(0, 300), deliveryId);
    }
  }
  return sent;
}
