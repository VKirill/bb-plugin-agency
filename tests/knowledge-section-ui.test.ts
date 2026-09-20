import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@get-bb/plugin-sdk/app", () => ({
  useRpc: () => ({ call: async () => ({ ok: true, value: [] }) }),
  Markdown: ({ content }: { content: string }) => content,
}));

import { hasTranslation, setUiLanguage, tr } from "../src/app/i18n";
import {
  knowledgeScopeKey,
  saveKnowledgeInputFromDraft,
  sectionScopeLabel,
  type KnowledgeDraft,
} from "../src/app/prototype/knowledge-live";
import type { KnowledgeItemView } from "../src/shared/rpc-contract";

const NEW_RUSSIAN = [
  "Раздел",
  "Раздел «{id}» · {project}",
  "Идентификатор раздела",
  "Привязка проекта-родителя",
  "Принятые материалы приходят в каждый запуск своей области: всего Агентства, отдела, проекта или раздела.",
  "Знания — то, что мы выяснили по отдельным поводам. Факты отдельного раздела пишутся в знания раздела. Паспорт — сводка о самом проекте, и он не повторяет ни то, ни другое.",
] as const;

function item(over: Partial<KnowledgeItemView> & Pick<KnowledgeItemView, "id" | "scopeKind" | "scopeId">): KnowledgeItemView {
  return {
    title: over.title ?? over.id,
    summary: "",
    body: "Текст",
    kind: "fact",
    importance: 50,
    pinned: false,
    writeReason: "",
    readCount: 0,
    lastReadAt: null,
    source: "QA",
    parentBindingId: over.parentBindingId ?? "bnd_parent",
    status: "accepted",
    proposedBy: null,
    revision: 1,
    createdAt: "2026-09-20T00:00:00.000Z",
    updatedAt: "2026-09-20T00:00:00.000Z",
    ...over,
  };
}

const sectionDraft = (over: Partial<KnowledgeDraft> = {}): KnowledgeDraft => ({
  revision: 0,
  title: "Тон раздела",
  body: "Пишем коротко.",
  source: "Владелец",
  scope: "section",
  sectionId: "sec_one",
  parentBindingId: "bnd_parent",
  ...over,
});

describe("knowledge section UI", () => {
  afterEach(() => setUiLanguage("ru"));

  it("gives every new Russian string an English pair", () => {
    for (const text of NEW_RUSSIAN) {
      expect(hasTranslation(text), text).toBe(true);
    }
    setUiLanguage("en");
    expect(tr("Раздел")).toBe("Section");
    expect(tr("Раздел «{id}» · {project}", { id: "sec_a", project: "BB-сервис" })).toBe("Section “sec_a” · BB-сервис");
  });

  it("keeps different sections in different scope keys", () => {
    const a = item({ id: "kn_a", scopeKind: "section", scopeId: "sec_a", parentBindingId: "bnd_1" });
    const b = item({ id: "kn_b", scopeKind: "section", scopeId: "sec_b", parentBindingId: "bnd_1" });
    expect(knowledgeScopeKey(a)).toBe("section:sec_a");
    expect(knowledgeScopeKey(b)).toBe("section:sec_b");
    expect(knowledgeScopeKey(a)).not.toBe(knowledgeScopeKey(b));
  });

  it("labels a section with Section and the section id plus parent project", () => {
    expect(sectionScopeLabel("sec_a", "BB-сервис")).toContain("Раздел");
    expect(sectionScopeLabel("sec_a", "BB-сервис")).toContain("sec_a");
    expect(sectionScopeLabel("sec_a", "BB-сервис")).toContain("BB-сервис");
    setUiLanguage("en");
    expect(sectionScopeLabel("sec_a", "BB-сервис")).toContain("Section");
  });

  it("sends saveKnowledge as section with scopeId and parentBindingId", () => {
    expect(saveKnowledgeInputFromDraft(sectionDraft())).toMatchObject({
      scopeKind: "section",
      scopeId: "sec_one",
      parentBindingId: "bnd_parent",
    });
    expect(saveKnowledgeInputFromDraft(sectionDraft({ scope: "section:sec_one" })).parentBindingId).toBe("bnd_parent");
    expect(saveKnowledgeInputFromDraft({ ...sectionDraft(), scope: "agency", sectionId: "", parentBindingId: "" })).not.toHaveProperty(
      "parentBindingId",
    );
  });
});
