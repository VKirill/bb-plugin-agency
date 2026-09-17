import { describe, expect, it } from "vitest";
import { charterPurpose, charterSection } from "../src/app/data/charter";

const charter = `## Назначение
Понятные тексты на русском: документация и публикации.

## Принимаем
- Документация и инструкции.
- Тексты интерфейса.

## Не принимаем:
- Изменения кода → «Разработка».`;

describe("department charter", () => {
  it("reads sections by heading", () => {
    expect(charterSection(charter, "Принимаем")).toBe("- Документация и инструкции.\n- Тексты интерфейса.");
    expect(charterSection(charter, "Не принимаем")).toBe("- Изменения кода → «Разработка».");
    expect(charterSection(charter, "Эскалация владельцу")).toBeNull();
    expect(charterSection(undefined, "Принимаем")).toBeNull();
    expect(charterSection("## Purpose\nShip code.\n\n## Accepts\n- Fixes", "Принимаем")).toBe("- Fixes");
    expect(charterPurpose("## Purpose\nShip code.")).toBe("Ship code.");
  });

  it("takes the purpose section, not the whole charter", () => {
    expect(charterPurpose(charter)).toBe("Понятные тексты на русском: документация и публикации.");
    expect(charterPurpose("Черновик, затем проверка.")).toBe("Черновик, затем проверка.");
    expect(charterPurpose(`## Назначение\n${"а".repeat(300)}`, 50)).toHaveLength(50);
    expect(charterPurpose("")).toBeNull();
  });
});
