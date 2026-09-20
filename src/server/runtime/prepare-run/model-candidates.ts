import { fail, type DomainError, type DomainResult } from "../../../domain";
import { agencyLanguage } from "../../i18n/language.js";
import { isUsageLimitDetail, type LaunchCandidate } from "../agent-fallback.js";

/**
 * A launch walks the employee's pairs in order: the primary, then the owner's reserves.
 * It moves on only when the refusal belongs to that one CLI/model on this machine, and
 * only while no thread exists. A machine that is off, a limit, a stale revision or an
 * unknown spawn outcome stops the walk: another model would not help, or would be unsafe.
 */

/** Refusals of one CLI/model pair on this machine; another pair may still start. */
const CANDIDATE_CODES = new Set([
  "provider_unavailable",
  "provider_cli_missing",
  "provider_cli_unsupported",
  "provider_disabled",
  "provider_constraint_mismatch",
  "model_unavailable",
]);

/** The queue keeps waiting on these; the rest is a refusal the owner has to look at. */
const TRANSIENT_CANDIDATE_CODES = new Set(["provider_unavailable", "provider_cli_missing"]);

const CANDIDATE_TEXT = /CLI (?:is )?(?:not installed|missing)|provider (?:is )?(?:not available|unavailable)|model (?:is )?(?:not found|not available|unavailable)/i;

export function refusalBelongsToCandidate(error: { code: string; message: string }): boolean {
  return CANDIDATE_CODES.has(error.code) || isUsageLimitDetail(error.message) || CANDIDATE_TEXT.test(error.message);
}

export type TriedCandidate = { candidate: LaunchCandidate; error: { code: string; message: string } };

export type CandidateLaunch<T> = {
  result: DomainResult<T>;
  /** The pair the launch really started on; null when nothing started. */
  used: LaunchCandidate | null;
  /** Pairs that were refused before `used`, in the order they were tried. */
  tried: TriedCandidate[];
};

export async function launchOnFirstReadyCandidate<T>(input: {
  candidates: readonly LaunchCandidate[];
  /** Machine readiness of this pair: CLI present and allowed, model in the catalog. */
  check: (candidate: LaunchCandidate) => Promise<DomainResult<void>>;
  /** Prepare and spawn on this pair. `position` is 0 for the first pair that reached a launch. */
  launch: (candidate: LaunchCandidate, position: number) => Promise<DomainResult<T>>;
  /** A launch that returned but created no thread for a reason of this pair; null when it started or must not be retried. */
  spawnRefusal: (value: T) => { code: string; message: string } | null;
}): Promise<CandidateLaunch<T>> {
  const tried: TriedCandidate[] = [];
  let position = 0;
  let last: DomainResult<T> | null = null;
  for (const candidate of input.candidates) {
    const ready = await input.check(candidate);
    if (!ready.ok) {
      if (!refusalBelongsToCandidate(ready.error)) return { result: ready, used: null, tried };
      tried.push({ candidate, error: ready.error });
      last = ready;
      continue;
    }
    const launched = await input.launch(candidate, position);
    position += 1;
    if (!launched.ok) {
      if (!refusalBelongsToCandidate(launched.error)) return { result: launched, used: null, tried };
      tried.push({ candidate, error: launched.error });
      last = launched;
      continue;
    }
    const refusal = input.spawnRefusal(launched.value);
    if (!refusal || !refusalBelongsToCandidate(refusal)) return { result: launched, used: candidate, tried };
    tried.push({ candidate, error: refusal });
    last = launched;
  }
  if (!last) return { result: fail("model_required", "the employee profile names no model to launch"), used: null, tried };
  // One pair and no reserves: the refusal exactly as it always was.
  if (tried.length <= 1) return { result: last, used: null, tried };
  // Several pairs were refused: one reason names them all. The queue keeps waiting while any refusal may pass by itself.
  return { result: { ok: false, error: refusedCandidatesError(tried) }, used: null, tried };
}

function pairName(candidate: { providerId: string; model: string }): string {
  return `${candidate.providerId} / ${candidate.model}`;
}

function sourceName(candidate: LaunchCandidate, en: boolean): string {
  if (candidate.source === "primary") return en ? "primary" : "основная";
  const index = candidate.source.slice("fallback ".length);
  return en ? `reserve ${index}` : `запасная ${index}`;
}

/** One refusal stays as it is; several become one reason that names every pair that was tried. */
export function refusedCandidatesError(tried: readonly TriedCandidate[]): DomainError {
  if (tried.length === 1) return tried[0]!.error;
  const en = agencyLanguage() === "en";
  const transient = tried.some((item) => TRANSIENT_CANDIDATE_CODES.has(item.error.code));
  const list = tried.map((item) => `${sourceName(item.candidate, en)} ${pairName(item.candidate)} — ${item.error.message}`).join("; ");
  return {
    code: transient ? "provider_unavailable" : "fallback_models_refused",
    message: en
      ? `None of the employee's models started on this machine. Tried: ${list}`
      : `Ни одна модель сотрудника не запустилась на этой машине. Опробованы: ${list}`,
  };
}

/** The job history line: which pair did not start and which one the launch runs on. */
export function fallbackLaunchText(input: { jobKey: string; tried: readonly TriedCandidate[]; used: LaunchCandidate }): string {
  const en = agencyLanguage() === "en";
  const skipped = input.tried
    .map((item) => `${sourceName(item.candidate, en)} ${pairName(item.candidate)} (${item.error.message})`)
    .join("; ");
  return en
    ? `Agency: ${input.jobKey} did not start on: ${skipped}. Launched on ${sourceName(input.used, en)} ${pairName(input.used)}. The employee profile is unchanged.`
    : `Агентство: ${input.jobKey} не запустилась на: ${skipped}. Запущена на модели «${sourceName(input.used, en)}» ${pairName(input.used)}. Профиль сотрудника не меняется.`;
}

/** The readiness line before the button is pressed: the launch will go to a reserve. */
export function fallbackReadinessText(input: { tried: readonly TriedCandidate[]; used: LaunchCandidate }): string {
  const en = agencyLanguage() === "en";
  const skipped = input.tried.map((item) => `${sourceName(item.candidate, en)} ${pairName(item.candidate)}`).join("; ");
  return en
    ? `Will not start on: ${skipped}. The launch will use ${sourceName(input.used, en)} ${pairName(input.used)}.`
    : `Не запустится на: ${skipped}. Запуск пойдёт на модели «${sourceName(input.used, en)}» ${pairName(input.used)}.`;
}
