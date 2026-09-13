import type { AgencyDatabase } from "../db/database";
import type { IntakeSource, Notification } from "../../shared/schemas";

export function createInbox(db: AgencyDatabase) {
  const read = db.prepare(`SELECT topic, reference FROM agency_inbox
    WHERE project_id = ? AND event_id = ?`);
  const insert = db.prepare(`INSERT INTO agency_inbox
    (project_id, event_id, source, topic, reference, received_at)
    VALUES (?, ?, ?, ?, ?, ?)`);
  const accept = db.transaction((input: Notification, source: IntakeSource) => {
    const existing = read.get(input.projectId, input.eventId) as
      { topic: string; reference: string } | undefined;
    if (existing) {
      if (existing.topic !== input.topic || existing.reference !== input.reference) {
        throw new Error("eventId уже использован для другого уведомления в этом проекте");
      }
      return { eventId: input.eventId, accepted: true as const,
        duplicate: true, state: "pending" as const, execution: "unavailable" as const };
    }
    insert.run(input.projectId, input.eventId, source, input.topic,
      input.reference, new Date().toISOString());
    return { eventId: input.eventId, accepted: true as const,
      duplicate: false, state: "pending" as const, execution: "unavailable" as const };
  });
  return {
    accept,
    count() {
      return (db.prepare("SELECT count(*) AS n FROM agency_inbox").get() as { n: number }).n;
    },
  };
}
export type Inbox = ReturnType<typeof createInbox>;
