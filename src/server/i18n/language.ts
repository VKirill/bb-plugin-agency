/**
 * Language of the Agency's side of the conversation with agents: the messages
 * it sends into worker threads and the language it asks agents to write in.
 * Set from the plugin setting; everything else reads it here.
 */
export type AgencyLanguage = "ru" | "en";

export const AGENCY_LANGUAGES: readonly AgencyLanguage[] = ["ru", "en"];

let current: AgencyLanguage = "ru";

export function agencyLanguage(): AgencyLanguage {
  return current;
}

export function setAgencyLanguage(next: unknown): AgencyLanguage {
  current = next === "en" ? "en" : "ru";
  return current;
}

/** One line for instructions: what language reports, comments and questions use. */
export function languageDirective(lang: AgencyLanguage = current): string {
  return lang === "en"
    ? "Language: write reports, job comments and questions to the owner in English."
    : "Язык: отчёты, комментарии к задачам и вопросы владельцу пишите на русском.";
}
