import type { SessionEffectiveMode, SessionPolicyMode } from "../shared/contracts/session-policy";

/** Three choices people see. inherit/delegate/pm all read as Agency. */
export const USER_SESSION_CHOICES = ["pm", "suggest", "ordinary"] as const;
export type UserSessionChoice = (typeof USER_SESSION_CHOICES)[number];

export const SESSION_MODE_OPTIONS: { value: UserSessionChoice; label: string }[] = [
  { value: "pm", label: "Агентство" },
  { value: "suggest", label: "По запросу" },
  { value: "ordinary", label: "Сам сделает" },
];

export function userSessionChoice(mode: SessionEffectiveMode | SessionPolicyMode): UserSessionChoice {
  if (mode === "suggest") return "suggest";
  if (mode === "ordinary") return "ordinary";
  return "pm";
}

export function userSessionLabel(mode: SessionEffectiveMode | SessionPolicyMode): string {
  const choice = userSessionChoice(mode);
  if (choice === "suggest") return "По запросу";
  if (choice === "ordinary") return "Сам сделает";
  return "Агентство";
}

export function effectiveModeLabel(mode: SessionEffectiveMode): string {
  return userSessionLabel(mode);
}

export function composerModeLabel(mode: SessionEffectiveMode): string {
  return userSessionLabel(mode);
}
