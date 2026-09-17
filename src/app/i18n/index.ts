import { EN_AUTOMATIONS } from "./en/automations";
import { EN_CORE } from "./en/core";
import { EN_DATA } from "./en/data";
import { EN_INSIGHTS } from "./en/insights";
import { EN_PLUGINS } from "./en/plugins";
import { EN_JOBS } from "./en/jobs";
import { EN_PROJECTS } from "./en/projects";
import { EN_SETTINGS } from "./en/settings";
import { EN_TEAM } from "./en/team";

/**
 * Interface language. Russian is the source: every visible text is written in
 * Russian in the code and looked up in the English dictionary when the Agency
 * language is English. A text without a translation stays Russian.
 *
 * The language is module state: the shell sets it before rendering and remounts
 * the tree when it changes, so plain helpers outside components translate too.
 */
export type UiLanguage = "ru" | "en";

const EN: Record<string, string> = { ...EN_CORE, ...EN_JOBS, ...EN_TEAM, ...EN_PROJECTS, ...EN_AUTOMATIONS, ...EN_SETTINGS, ...EN_DATA, ...EN_INSIGHTS, ...EN_PLUGINS };

let current: UiLanguage = "ru";

export function setUiLanguage(language: UiLanguage): void {
  current = language;
}

export function uiLanguage(): UiLanguage {
  return current;
}

/** Locale for dates and numbers. */
export function uiLocale(): string {
  return current === "en" ? "en-GB" : "ru-RU";
}

/**
 * Translates a Russian source text. `{name}` placeholders are filled from vars
 * in both languages, so a template reads the same in the code and the dictionary.
 */
export function tr(text: string, vars?: Record<string, string | number | null | undefined>): string {
  const template = current === "en" ? (EN[text] ?? text) : text;
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (whole, key: string) => (key in vars ? String(vars[key] ?? "") : whole));
}

/** Translates only strings; anything else (elements, numbers) passes through. */
export function trNode<T>(value: T): T {
  return (typeof value === "string" ? tr(value) : value) as T;
}

export function hasTranslation(text: string): boolean {
  return text in EN;
}
