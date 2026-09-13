import { notificationSchema, type IntakeSource } from "../../shared/schemas";
import type { Inbox } from "../inbox/store";

export function receiveNotification(inbox: Inbox, input: unknown, source: IntakeSource) {
  return inbox.accept(notificationSchema.parse(input), source);
}
