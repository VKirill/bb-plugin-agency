import type { VerifiedWebhook, WebhookSource } from "../webhook-auth.js";

export type WebhookSourcePort = {
  resolve(sourceId: string): WebhookSource | null;
};

export type WebhookInboxDraft = {
  sourceId: string;
  projectId: string;
  eventId: string;
  topic: string;
  bodyDigest: string;
  namespace: "integration";
  envelope: VerifiedWebhook["envelope"];
};

export type WebhookInboxPersist =
  | { ok: true; receiptId: string; duplicate: boolean; state: "accepted" }
  | { ok: false; code: "event_conflict" | "persist_unavailable" | "payload_schema_mismatch" | "payload_schema_unsupported" | "scope_unbound" };

/** Durable typed Inbox. Not a launcher. Payload subset is enforced by ingest. */
export type WebhookInboxPort = {
  persistAccepted(draft: WebhookInboxDraft): WebhookInboxPersist;
};
