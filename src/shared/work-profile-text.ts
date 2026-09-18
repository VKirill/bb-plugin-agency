/**
 * Текст профиля работы так, как его увидит сотрудник в запуске. Один источник для сервера и для
 * предпросмотра в интерфейсе: владелец правит форму и сразу видит, что доедет до промпта.
 */

export type WorkProfileTextInput = {
  key: string;
  title: string;
  body: string;
  samples: readonly { label: string; ref: string; note?: string }[];
  acceptance: string;
};

/** Сколько знаков профиля доходит до промпта: остальное живёт в проекте и читается по ссылке. */
export const WORK_PROFILE_LIMIT = 4_000;

export function workProfileText(profile: WorkProfileTextInput): string {
  const samples = profile.samples.length
    ? [
        "Эталоны (одобрены владельцем, держим эту планку):",
        ...profile.samples.map((sample) => `- ${sample.label}: ${sample.ref}${sample.note ? ` — ${sample.note}` : ""}`),
      ]
    : [];
  const acceptance = profile.acceptance.trim() ? ["Дополнительно к критерию приёмки задачи:", profile.acceptance.trim()] : [];
  return [`Профиль работы проекта «${profile.title}» (${profile.key}):`, profile.body.trim(), ...samples, ...acceptance]
    .join("\n")
    .slice(0, WORK_PROFILE_LIMIT);
}
