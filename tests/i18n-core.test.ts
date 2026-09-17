import { afterEach, describe, expect, it } from "vitest";
import { setUiLanguage, tr, trNode, uiLocale } from "../src/app/i18n";

afterEach(() => setUiLanguage("ru"));

describe("interface language", () => {
  it("keeps Russian by default and fills placeholders", () => {
    expect(tr("Задачи: {count}", { count: 3 })).toBe("Задачи: 3");
    expect(uiLocale()).toBe("ru-RU");
  });

  it("falls back to the Russian source when a text has no translation", () => {
    setUiLanguage("en");
    expect(tr("Текст без перевода {x}", { x: 1 })).toBe("Текст без перевода 1");
    expect(uiLocale()).toBe("en-GB");
    expect(trNode(42)).toBe(42);
  });
});
