import { agencyLanguage } from "../i18n/language.js";
import {
  fallbackModelKey,
  optionalReasoningEffort,
  optionalServiceTier,
  type AgentFallbackModel,
  type AgentVersion,
} from "../../shared/contracts/versions.js";
import type { SqlDatabase } from "../db/sql.js";

/**
 * The owner names reserve CLI/model pairs on the employee, in priority order. Catalog
 * substitution (`resolveModelChoice`) is a different thing: it suggests the closest model
 * of the same family and never launches by itself. This module is only the owner-set
 * reserves: which one a launch takes, and the usage-limit switch onto the next one.
 */

export type { AgentFallbackModel };

/** Where the launched model came from: the profile's primary or its N-th reserve (1-based). */
export type LaunchModelSource = "primary" | `fallback ${number}`;

export type LaunchCandidate = AgentFallbackModel & {
  source: LaunchModelSource;
  /** A running attempt hit a usage limit on this pair recently; it is tried after the fresh ones. */
  exhausted: boolean;
};

/** Same window BB waits for a subscription reset; after this the pair is tried first again. */
export const MODEL_EXHAUSTED_MS = 6 * 60 * 60_000;

export const AGENT_FALLBACK_MIGRATION = `
ALTER TABLE agency_agent_version ADD COLUMN fallback_provider_id TEXT;
ALTER TABLE agency_agent_version ADD COLUMN fallback_model TEXT;
ALTER TABLE agency_agent_version ADD COLUMN fallback_reasoning_effort TEXT
  CHECK (
    fallback_reasoning_effort IS NULL OR fallback_reasoning_effort IN (
      'none', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'ultracode'
    )
  );
ALTER TABLE agency_agent_version ADD COLUMN fallback_service_tier TEXT
  CHECK (fallback_service_tier IS NULL OR fallback_service_tier IN ('default', 'fast'));
CREATE TABLE agency_agent_primary_exhausted (
  agent_id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL,
  model TEXT NOT NULL,
  exhausted_at TEXT NOT NULL,
  until_at TEXT NOT NULL
)`;

/** The ordered list replaces the single reserve; exhaustion is remembered per pair, not per employee. */
export const AGENT_FALLBACK_LIST_MIGRATION = `
ALTER TABLE agency_agent_version ADD COLUMN fallback_models_json TEXT;
CREATE TABLE agency_agent_model_exhausted (
  agent_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  model TEXT NOT NULL,
  exhausted_at TEXT NOT NULL,
  until_at TEXT NOT NULL,
  PRIMARY KEY (agent_id, provider_id, model)
);
INSERT INTO agency_agent_model_exhausted (agent_id, provider_id, model, exhausted_at, until_at)
  SELECT agent_id, provider_id, model, exhausted_at, until_at FROM agency_agent_primary_exhausted`;

/** Usage/quota/subscription — not overload, timeout or a dropped connection. */
const USAGE_LIMIT_TEXT =
  /usage limit|usageLimitExceeded|quota|subscription(?: window)?|rate.?limit|лимит подписки|исчерпан(?:ный)? лимит|достигнут лимит|лимит запросов/i;

export function isUsageLimitDetail(detail: string | null | undefined): boolean {
  return Boolean(detail && USAGE_LIMIT_TEXT.test(detail));
}

type ProfileModels = Pick<AgentVersion, "providerId" | "model" | "reasoningEffort" | "serviceTier" | "fallbackModels">;

/** The owner's reserves in priority order, without a repeat of the primary or of each other. */
export function profileFallbacks(version: ProfileModels): AgentFallbackModel[] {
  const seen = new Set([fallbackModelKey(version)]);
  const list: AgentFallbackModel[] = [];
  for (const pick of version.fallbackModels ?? []) {
    if (!pick.providerId.trim() || !pick.model.trim()) continue;
    const key = fallbackModelKey(pick);
    if (seen.has(key)) continue;
    seen.add(key);
    list.push(pick);
  }
  return list;
}

/**
 * What a launch may start on, in the order it is tried: the primary, then the reserves.
 * A pair that hit a usage limit a moment ago moves behind the fresh ones; an empty reserve
 * list gives the primary alone, which is the launch as it always was.
 */
export function launchCandidates(db: SqlDatabase, agentId: string, version: ProfileModels, now: string): LaunchCandidate[] {
  const exhausted = exhaustedModelKeys(db, agentId, now);
  const ordered: LaunchCandidate[] = [
    {
      source: "primary",
      providerId: version.providerId,
      model: version.model,
      ...optionalReasoningEffort(version.reasoningEffort),
      ...optionalServiceTier(version.serviceTier),
      exhausted: exhausted.has(fallbackModelKey(version)),
    },
    ...profileFallbacks(version).map(
      (pick, index): LaunchCandidate => ({
        ...pick,
        source: `fallback ${index + 1}`,
        exhausted: exhausted.has(fallbackModelKey(pick)),
      }),
    ),
  ];
  return [...ordered.filter((item) => !item.exhausted), ...ordered.filter((item) => item.exhausted)];
}

/** Overlay the chosen pair onto the primary fields for this launch only; the stored profile is untouched. */
export function applyLaunchCandidate<T extends AgentVersion>(version: T, candidate: AgentFallbackModel & { source?: LaunchModelSource }): T {
  if (candidate.source === "primary" || fallbackModelKey(candidate) === fallbackModelKey(version)) return version;
  const { reasoningEffort: _effort, serviceTier: _tier, ...rest } = version;
  return {
    ...rest,
    providerId: candidate.providerId,
    model: candidate.model,
    ...optionalReasoningEffort(candidate.reasoningEffort),
    ...optionalServiceTier(candidate.serviceTier),
  } as T;
}

/** The slot of the pair a launch really used; a pair the profile no longer names counts as primary. */
export function launchModelSource(version: ProfileModels, used: { providerId: string; model: string }): LaunchModelSource {
  const index = profileFallbacks(version).findIndex((pick) => fallbackModelKey(pick) === fallbackModelKey(used));
  return index >= 0 ? `fallback ${index + 1}` : "primary";
}

/** The snapshot may carry the primary or a reserve the owner listed — never another pair. */
export function profileNamesModel(version: ProfileModels, used: { providerId: string; model: string }): boolean {
  const key = fallbackModelKey(used);
  return key === fallbackModelKey(version) || profileFallbacks(version).some((pick) => fallbackModelKey(pick) === key);
}

export function markModelExhausted(
  db: SqlDatabase,
  input: { agentId: string; providerId: string; model: string; now: string; untilMs?: number },
): void {
  const until = new Date(Date.parse(input.now) + (input.untilMs ?? MODEL_EXHAUSTED_MS)).toISOString();
  db.prepare(
    `INSERT INTO agency_agent_model_exhausted (agent_id, provider_id, model, exhausted_at, until_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(agent_id, provider_id, model) DO UPDATE SET
       exhausted_at = excluded.exhausted_at, until_at = excluded.until_at`,
  ).run(input.agentId, input.providerId, input.model, input.now, until);
}

function exhaustedModelKeys(db: SqlDatabase, agentId: string, now: string): Set<string> {
  const rows = db
    .prepare(`SELECT provider_id, model, until_at FROM agency_agent_model_exhausted WHERE agent_id = ?`)
    .all(agentId) as { provider_id: string; model: string; until_at: string }[];
  return new Set(
    rows
      .filter((row) => Date.parse(row.until_at) > Date.parse(now))
      .map((row) => fallbackModelKey({ providerId: row.provider_id, model: row.model })),
  );
}

export function modelIsExhausted(
  db: SqlDatabase,
  agentId: string,
  pick: { providerId: string; model: string },
  now: string,
): boolean {
  return exhaustedModelKeys(db, agentId, now).has(fallbackModelKey(pick));
}

export function clearExhaustedModels(db: SqlDatabase, agentId: string): void {
  db.prepare(`DELETE FROM agency_agent_model_exhausted WHERE agent_id = ?`).run(agentId);
}

/** After a usage limit on `used`: the next pair of the profile that is not exhausted itself. */
export function nextFreshCandidate(
  db: SqlDatabase,
  agentId: string,
  version: ProfileModels,
  used: { providerId: string; model: string },
  now: string,
): LaunchCandidate | null {
  const usedKey = fallbackModelKey(used);
  return (
    launchCandidates(db, agentId, version, now).find((item) => !item.exhausted && fallbackModelKey(item) !== usedKey) ?? null
  );
}

export function fallbackSwitchText(input: {
  jobKey: string;
  fromProviderId: string;
  fromModel: string;
  toProviderId: string;
  toModel: string;
}): string {
  if (agencyLanguage() === "en") {
    return `Agency: ${input.jobKey} hit a usage limit on ${input.fromProviderId} / ${input.fromModel}. Switching this job to the reserve ${input.toProviderId} / ${input.toModel} and launching a new attempt. The employee profile is unchanged.`;
  }
  return `Агентство: у ${input.jobKey} закончился лимит ${input.fromProviderId} / ${input.fromModel}. Переключаю на резерв ${input.toProviderId} / ${input.toModel} и запускаю новую попытку. Профиль сотрудника не меняется.`;
}
