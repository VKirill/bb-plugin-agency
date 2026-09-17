import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { openMigratedDatabase } from "../src/server/db";
import { currentAgencyRules, listAgencyRulesVersions, listTemplates, saveAgencyRules, saveTemplate } from "../src/server/templates/store";
import { DEFAULT_TEMPLATES } from "../src/shared/templates";

const NOW = "2026-09-17T10:00:00.000Z";
const open = () => openMigratedDatabase(new Database(":memory:"));

describe("form templates", () => {
  it("starts from the standard texts and keeps the owner's text until a reset", () => {
    const db = open();
    expect(listTemplates(db).find((row) => row.key === "brief")).toEqual({ key: "brief", text: DEFAULT_TEMPLATES.brief, custom: false, revision: 0 });
    const saved = saveTemplate(db, { key: "brief", expectedRevision: 0, text: "Цель: …\nГраницы: …" }, NOW);
    expect(saved.ok && saved.value).toMatchObject({ custom: true, revision: 1 });
    expect(saveTemplate(db, { key: "brief", expectedRevision: 0, text: "Другое" }, NOW)).toMatchObject({ ok: false, error: { code: "revision_conflict" } });
    const reset = saveTemplate(db, { key: "brief", expectedRevision: 1, text: null }, NOW);
    expect(reset.ok && reset.value).toEqual({ key: "brief", text: DEFAULT_TEMPLATES.brief, custom: false, revision: 0 });
  });

  it("refuses an empty template and a charter without «Принимаем»", () => {
    const db = open();
    expect(saveTemplate(db, { key: "acceptance", expectedRevision: 0, text: "   " }, NOW)).toMatchObject({ ok: false, error: { code: "template_empty" } });
    expect(saveTemplate(db, { key: "charter", expectedRevision: 0, text: "## Назначение\nКод." }, NOW)).toMatchObject({ ok: false, error: { code: "template_invalid" } });
    expect(saveTemplate(db, { key: "charter", expectedRevision: 0, text: "## Принимаем\n- Код" }, NOW).ok).toBe(true);
  });
});

describe("agency rules versions", () => {
  it("saves a new version only when the text changes and an empty text switches the layer off", () => {
    const db = open();
    expect(currentAgencyRules(db)).toBe(null);
    const first = saveAgencyRules(db, { expectedVersion: 0, text: "Отчёты — по-русски." }, NOW);
    expect(first.ok && first.value).toMatchObject({ version: 1, text: "Отчёты — по-русски." });
    expect(saveAgencyRules(db, { expectedVersion: 1, text: "Отчёты — по-русски.  " }, NOW).ok).toBe(true);
    expect(listAgencyRulesVersions(db)).toHaveLength(1);
    expect(saveAgencyRules(db, { expectedVersion: 0, text: "Старая база" }, NOW)).toMatchObject({ ok: false, error: { code: "revision_conflict" } });
    const off = saveAgencyRules(db, { expectedVersion: 1, text: "" }, NOW);
    expect(off.ok && off.value).toBe(null);
    expect(currentAgencyRules(db)).toBe(null);
    expect(listAgencyRulesVersions(db).map((row) => row.version)).toEqual([2, 1]);
  });
});
