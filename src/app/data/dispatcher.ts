/** AGY-11 UI: typed dispatcher allowlist only. Shared/server stay backend-owned. */

import {
  actionIntentRecordSchema,
  approveActionIntentCommandSchema,
  claimActionIntentCommandSchema,
  dispatchTickCommandSchema,
  dispatchTickRecordSchema,
  ingestInboxEventCommandSchema,
  listActionIntentsCommandSchema,
  listDispatcherCatalogCommandSchema,
  listedActionIntentSchema,
  saveEventDefinitionCommandSchema,
  saveEventSourceCommandSchema,
  saveRuleVersionCommandSchema,
  type ActionIntentRecord,
  type CatalogRuleRecord,
  type EventDefinitionRecord,
  type EventSourceRecord,
  type ListedActionIntent,
  type ApproveActionIntentCommand,
  type ClaimActionIntentCommand,
  type DispatchTickCommand,
  type DispatchTickRecord,
  type InboxEventRecord,
  type IngestInboxEventCommand,
  type SaveEventDefinitionCommand,
  type SaveEventSourceCommand,
  type SaveRuleVersionCommand,
} from "../../shared/contracts";
import type { AgencyApi } from "./agency-api";
import type { MutationOutcome } from "./envelope";

export const INTENT_LAUNCH_UNAVAILABLE =
  "Задачу из этого правила сейчас запустить нельзя.";

export const INTENT_NO_SPAWN =
  "Задачу из этого правила сейчас запустить нельзя.";

export const INTENT_APPROVE_HINT = "Правило согласовано. Исполнитель сам не запускается.";

export const INTENT_CLAIM_HINT = "Запись взята в работу. Задачу отсюда запустить нельзя.";

export const INTENT_TICK_HINT = "Проверили новые события.";

export const INTENT_FILTER_HINT =
  "Показывается то, что вернул сервер.";

export const LEGACY_NOTIFY_HINT =
  "Старые уведомления остаются в истории и не запускают правила.";

export const INTENT_NO_LIST_RULES =
  "Можно выбрать сохранённый тип, источник или правило. Новую запись по-прежнему задают полями.";

export const DISPATCHER_EMPTY = "Пока нечего согласовывать.";

export const DISPATCHER_INVALID_FIELDS = "Проверьте название и обязательные поля.";

export const DISPATCHER_NO_PROJECT = "Нужен проект из рабочего пространства.";

export const DISPATCHER_NO_BB_PROJECT =
  "У этой привязки нет кода проекта BB. Источник и правило сейчас недоступны.";

export const DISPATCHER_SHARED_BB_SCOPE =
  "Несколько привязок смотрят на один проект BB. Источники и правила общие — это не отдельные области.";

export const DISPATCHER_PAGE_HINT =
  "Можно выбрать сохранённые типы, источники и правила или добавить новые.";

export const INGEST_ACCEPTED = "Событие принято.";

export const INGEST_DUPLICATE = "Такое событие уже есть.";

export const INGEST_NEXT_HINT = "Чтобы принять другое событие, начните следующее.";

export const INGEST_UNKNOWN = "Событие не принято. Повторите тот же черновик.";

export const INGEST_SOURCE_GONE =
  "Сохранённый источник сейчас недоступен. Событие нельзя принять.";

export const INGEST_DRAFT_SCHEMA = 1 as const;

export type IngestDraftRecord = {
  schema: typeof INGEST_DRAFT_SCHEMA;
  eventId: string;
  sourceId: string;
  topic: string;
  reference: string;
  body: string;
  accepted: boolean;
};

export function ingestDraftStorageKey(bbProjectId: string): string {
  return `agency.ingest-draft.v1:${bbProjectId}`;
}

export function newDraftEventId(): string {
  return `evt_${crypto.randomUUID()}`;
}

export function emptyIngestDraft(sourceId = ""): IngestDraftRecord {
  return {
    schema: INGEST_DRAFT_SCHEMA,
    eventId: newDraftEventId(),
    sourceId,
    topic: "research.delivered",
    reference: "artifact:research-1",
    body: '{"data":{"status":"ready"}}',
    accepted: false,
  };
}

export function parseIngestDraft(value: unknown): IngestDraftRecord | null {
  if (!value || typeof value !== "object") return null;
  const rec = value as Record<string, unknown>;
  if (rec.schema !== INGEST_DRAFT_SCHEMA) return null;
  if (typeof rec.eventId !== "string" || !rec.eventId.trim()) return null;
  if (typeof rec.sourceId !== "string") return null;
  if (typeof rec.topic !== "string" || !rec.topic.trim()) return null;
  if (typeof rec.reference !== "string") return null;
  if (typeof rec.body !== "string") return null;
  if (typeof rec.accepted !== "boolean") return null;
  return {
    schema: INGEST_DRAFT_SCHEMA,
    eventId: rec.eventId,
    sourceId: rec.sourceId,
    topic: rec.topic,
    reference: rec.reference,
    body: rec.body,
    accepted: rec.accepted,
  };
}

export function readIngestDraft(
  storage: { getItem(key: string): string | null },
  bbProjectId: string,
): IngestDraftRecord | null {
  if (!bbProjectId) return null;
  try {
    const raw = storage.getItem(ingestDraftStorageKey(bbProjectId));
    if (!raw) return null;
    return parseIngestDraft(JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
}

export function writeIngestDraft(
  storage: { setItem(key: string, value: string): void },
  bbProjectId: string,
  draft: IngestDraftRecord,
): void {
  if (!bbProjectId) return;
  try {
    storage.setItem(ingestDraftStorageKey(bbProjectId), JSON.stringify(draft));
  } catch {
    /* private mode: keep memory only */
  }
}

export function ingestDraftAccepted(result: { ok: boolean; duplicate?: boolean }): boolean {
  return result.ok && result.duplicate !== true;
}

export const SOURCE_KIND_LABEL: Record<string, string> = {
  notify: "Уведомление",
  webhook: "Внешний адрес",
  cron: "По расписанию",
  bb_lifecycle: "Событие BB",
};

export function sourceKindLabel(kind: string): string {
  return SOURCE_KIND_LABEL[kind] ?? kind;
}

export function intentCatalogHeading(intent: ListedActionIntent): string {
  const name = intent.definitionLabel?.trim() || intent.ruleLabel?.trim();
  if (name) return name;
  return INTENT_STATE_LABEL[intent.state];
}

export function intentCatalogSubline(intent: ListedActionIntent): string {
  const parts = [intent.topic?.trim(), intent.sourceKind ? sourceKindLabel(intent.sourceKind) : ""].filter(Boolean);
  const status = intentStatusNotice(intent);
  if (!parts.length) return status;
  if (status === INTENT_STATE_LABEL[intent.state]) return parts.join(" · ");
  return `${parts.join(" · ")} · ${status}`;
}

export function resolveWorkspaceProjectId(
  projects: readonly { id: string }[],
  currentId: string,
): string {
  if (currentId && projects.some((item) => item.id === currentId)) return currentId;
  return projects[0]?.id ?? "";
}

export type CatalogProject = { id: string; bbProjectId?: string };

/** Binding id only when it matches id or a unique bbProjectId. No first-item fallback. */
export function resolveCatalogBindingId(
  projects: readonly CatalogProject[],
  currentId: string,
): string {
  if (currentId && projects.some((item) => item.id === currentId)) return currentId;
  const matches = projects.filter((item) => item.bbProjectId && item.bbProjectId === currentId);
  return matches.length === 1 ? matches[0]!.id : "";
}

/** Dispatcher source/rule scope: binding.bbProjectId, never binding.id. */
export function catalogBbProjectId(
  projects: readonly CatalogProject[],
  currentId: string,
): string {
  if (!currentId) return "";
  const byBinding = projects.find((item) => item.id === currentId);
  if (byBinding) return byBinding.bbProjectId?.trim() || "";
  if (projects.some((item) => item.bbProjectId === currentId)) return currentId;
  return "";
}

export function catalogSharedBbBindingCount(
  projects: readonly CatalogProject[],
  bbProjectId: string,
): number {
  if (!bbProjectId) return 0;
  return projects.filter((item) => item.bbProjectId === bbProjectId).length;
}

export const INTENT_STATE_LABEL: Record<ActionIntentRecord["state"], string> = {
  observed: "Наблюдение",
  awaiting_approval: "Ждёт согласования",
  queued: "В очереди",
  claimed: "В работе",
  succeeded: "Готово",
  skipped: "Пропущено",
  failed: "Ошибка",
  canceled: "Отменено",
};

export function intentTechnicalSummary(intent: ActionIntentRecord): string {
  return [
    `id ${intent.id}`,
    `revision ${intent.revision}`,
    `fence ${intent.fencingToken ?? "—"} / ${intent.fencingGeneration}`,
    intent.jobId ? `job ${intent.jobId}` : "job —",
    intent.lastError ? `error ${intent.lastError}` : null,
  ].filter(Boolean).join(" · ");
}

export type IntentUiAction = "approve" | "claim" | "none";

export function nextIntentUiAction(intent: Pick<ActionIntentRecord, "state">): IntentUiAction {
  if (intent.state === "awaiting_approval") return "approve";
  if (intent.state === "queued") return "claim";
  return "none";
}

export function intentLaunchBlocked(intent: Pick<ActionIntentRecord, "jobId" | "lastError" | "liveGate">): boolean {
  return intent.jobId == null || intent.lastError === "capability_unavailable" || intent.liveGate === false;
}

export function intentStatusNotice(intent: ActionIntentRecord): string {
  if (intent.lastError === "capability_unavailable") return INTENT_LAUNCH_UNAVAILABLE;
  if (intent.jobId == null && (intent.state === "failed" || intent.state === "claimed" || intent.state === "queued")) {
    return INTENT_NO_SPAWN;
  }
  return INTENT_STATE_LABEL[intent.state];
}

export function parseActionIntents(value: unknown): ActionIntentRecord[] | null {
  const parsed = actionIntentRecordSchema.array().safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function parseListedActionIntents(value: unknown): ListedActionIntent[] | null {
  const parsed = listedActionIntentSchema.array().safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function parseDispatchTick(value: unknown): DispatchTickRecord | null {
  const parsed = dispatchTickRecordSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export type DispatcherApi = Pick<
  AgencyApi,
  | "saveEventDefinition"
  | "saveEventSource"
  | "saveRuleVersion"
  | "ingestInboxEvent"
  | "dispatchTick"
  | "listActionIntents"
  | "listEventDefinitions"
  | "listEventSources"
  | "listRuleVersions"
  | "claimActionIntent"
  | "approveActionIntent"
>;

export function intentsAwaitingApproval<T extends ActionIntentRecord>(intents: readonly T[]): T[] {
  return intents.filter((item) => item.state === "awaiting_approval");
}

export const dispatcherCommand = {
  saveDefinition: saveEventDefinitionCommandSchema,
  saveSource: saveEventSourceCommandSchema,
  saveRule: saveRuleVersionCommandSchema,
  ingest: ingestInboxEventCommandSchema,
  tick: dispatchTickCommandSchema,
  list: listActionIntentsCommandSchema,
  listCatalog: listDispatcherCatalogCommandSchema,
  claim: claimActionIntentCommandSchema,
  approve: approveActionIntentCommandSchema,
};

export type {
  ActionIntentRecord,
  ApproveActionIntentCommand,
  CatalogRuleRecord,
  ClaimActionIntentCommand,
  DispatchTickCommand,
  DispatchTickRecord,
  EventDefinitionRecord,
  EventSourceRecord,
  InboxEventRecord,
  IngestInboxEventCommand,
  ListedActionIntent,
  SaveEventDefinitionCommand,
  SaveEventSourceCommand,
  SaveRuleVersionCommand,
};
