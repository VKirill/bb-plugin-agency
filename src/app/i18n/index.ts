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

const STORED_LANGUAGE_KEY = "bb-agency:ui-language";

// Starts from the remembered language: panels mounted before the shell (sidebar, file opener) match it.
let current: UiLanguage = storedUiLanguage();

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

/** Keeps the language for the next app load: the BB sidebar title is set before any server call. */
export function rememberUiLanguage(language: UiLanguage): void {
  try {
    if (typeof window !== "undefined") window.localStorage?.setItem(STORED_LANGUAGE_KEY, language);
  } catch {
    // Storage may be unavailable (private mode, tests): the title follows the BB language, then Russian.
  }
}

export function storedUiLanguage(): UiLanguage {
  try {
    if (typeof window === "undefined") return "ru";
    const stored = window.localStorage?.getItem(STORED_LANGUAGE_KEY);
    if (stored === "en" || stored === "ru") return stored;
    const lang = (typeof document !== "undefined" ? document.documentElement.lang : "").toLowerCase();
    if (lang.startsWith("en")) return "en";
    return "ru";
  } catch {
    return "ru";
  }
}

/**
 * The BB Russifier translates English words anywhere in the page, ours too. In English
 * the Agency marks its roots and overlays so the English text stays as written.
 */
export function ruSkipProps(): { "data-bb-ru-skip"?: "" } {
  return current === "en" ? { "data-bb-ru-skip": "" } : {};
}

export function hasTranslation(text: string): boolean {
  return text in EN;
}
