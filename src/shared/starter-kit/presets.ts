import type { KitModel } from "../starter-kit.js";

/**
 * Модели стартовых сотрудников по виду работы. Планирует и собирает сильная модель, код пишет
 * быстрая, проверяет модель другого вендора, чтение и сбор уходят самой дешёвой. Если такого CLI
 * в этом BB нет, установка подставит ближайшую подключённую модель.
 */

/** Стратегия и архитектура: план, границы, разбивка. */
export const FABLE: KitModel = {
  providerId: "claude-code",
  model: "claude-fable-5-1",
  reasoningEffort: "medium",
  label: { ru: "Claude Fable 5.1 · Claude Code", en: "Claude Fable 5.1 · Claude Code" },
};

/** Координация, текст, продукт, маркетинг: рассуждение без кода. */
export const OPUS: KitModel = {
  providerId: "claude-code",
  model: "claude-opus-5[1m]",
  reasoningEffort: "high",
  label: { ru: "Claude Opus 5 (1M) · Claude Code", en: "Claude Opus 5 (1M) · Claude Code" },
};

/** Основная производственная работа: тексты, аналитика, макеты. */
export const SONNET: KitModel = {
  providerId: "claude-code",
  model: "claude-sonnet-5",
  reasoningEffort: "medium",
  label: { ru: "Claude Sonnet 5 · Claude Code", en: "Claude Sonnet 5 · Claude Code" },
};

/** Код по плану: быстрый режим другого вендора, чем у проверяющего. */
export const GROK: KitModel = {
  providerId: "acp-cursor",
  model: "grok-4.6",
  reasoningEffort: "medium",
  serviceTier: "fast",
  label: { ru: "Grok 4.6 · быстрый режим · Cursor", en: "Grok 4.6 · fast mode · Cursor" },
};

/** Проверка: другой вендор, чем у исполнителя. */
export const SOL: KitModel = {
  providerId: "codex",
  model: "gpt-5.6-sol",
  reasoningEffort: "high",
  label: { ru: "GPT-5.6-Sol · Codex", en: "GPT-5.6-Sol · Codex" },
};

/** Чтение кода: много контекста, дёшево. */
export const TERRA: KitModel = {
  providerId: "codex",
  model: "gpt-5.6-terra",
  reasoningEffort: "low",
  serviceTier: "fast",
  label: { ru: "GPT-5.6-Terra · быстрый режим · Codex", en: "GPT-5.6-Terra · fast mode · Codex" },
};

/** Лёгкая массовая работа: сбор, выписки, таблицы. */
export const LUNA: KitModel = {
  providerId: "codex",
  model: "gpt-5.6-luna",
  reasoningEffort: "low",
  serviceTier: "fast",
  label: { ru: "GPT-5.6-Luna · быстрый режим · Codex", en: "GPT-5.6-Luna · fast mode · Codex" },
};

/** Секретарь руководителя: та же Luna, высокий reasoning в быстром режиме. */
export const LUNA_HIGH: KitModel = {
  providerId: "codex",
  model: "gpt-5.6-luna",
  reasoningEffort: "high",
  serviceTier: "fast",
  label: { ru: "GPT-5.6-Luna · высокий · быстрый режим · Codex", en: "GPT-5.6-Luna · high · fast mode · Codex" },
};

/** Редактура языка: вкус к формулировкам. */
export const FABLE_EDIT: KitModel = {
  providerId: "claude-code",
  model: "claude-fable-5-1",
  reasoningEffort: "medium",
  label: { ru: "Claude Fable 5.1 · Claude Code", en: "Claude Fable 5.1 · Claude Code" },
};
