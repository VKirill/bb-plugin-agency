import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { resolveAlias } from "../src/server/cli/aliases";
import { CLI_EXAMPLES } from "../src/server/cli/examples";
import { CLI_OPERATIONS } from "../src/server/cli/operations";
import { openMigratedDatabase } from "../src/server/db";
import { formatIdeaMarkdown } from "../src/server/ideas/format";
import { getIdea, ideaRelativePath, listIdeas, saveIdea, setIdeaStatus } from "../src/server/ideas/store";
import { buildIdeaThreadSpawn } from "../src/server/ideas/thread";
import { ideaThreadComposerPrompt } from "../src/shared/idea-thread";
import { listIdeasInputSchema, saveIdeaInputSchema, spawnIdeaThreadInputSchema } from "../src/shared/rpc-contract";

const NOW = "2026-09-20T11:00:00.000Z";
const BINDING = "bnd_aaaaaaaaaaaa";

function db() {
  return openMigratedDatabase(new Database(":memory:"));
}

describe("склад идей", () => {
  it("сохраняет идею с путём файла и фильтрует по проекту", () => {
    const database = db();
    const saved = saveIdea(
      database,
      {
        expectedRevision: 0,
        title: "Склад идей",
        body: "## Суть\nДержать мысли файлами.",
        kind: "idea",
        bindingId: BINDING,
        sectionId: "sec_aaaaaaaaaaaaaaaa",
        sectionLabel: "Плагины",
        sourceThreadId: "thr_aaaaaaaaaaaa",
      },
      NOW,
    );
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    expect(saved.value.id.startsWith("ide_")).toBe(true);
    expect(saved.value.relativePath).toBe(ideaRelativePath(saved.value.id));
    expect(listIdeas(database, { bindingId: BINDING })).toHaveLength(1);
    expect(listIdeas(database, { bindingId: "bnd_bbbbbbbbbbbb" })).toHaveLength(0);
    expect(listIdeas(database, { kind: "todo" })).toHaveLength(0);
    expect(getIdea(database, saved.value.id)?.title).toBe("Склад идей");
  });

  it("меняет статус с ревизией и отклоняет конфликт", () => {
    const database = db();
    const saved = saveIdea(
      database,
      { expectedRevision: 0, title: "Туду", body: "## Суть\nПроверить UI.", kind: "todo", bindingId: BINDING },
      NOW,
    );
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    const parked = setIdeaStatus(database, { id: saved.value.id, expectedRevision: saved.value.revision, status: "parked" }, NOW);
    expect(parked.ok && parked.value.status).toBe("parked");
    expect(setIdeaStatus(database, { id: saved.value.id, expectedRevision: saved.value.revision, status: "done" }, NOW).ok).toBe(false);
  });

  it("собирает markdown с шапкой и заголовком", () => {
    const text = formatIdeaMarkdown({
      id: "ide_aaaaaaaaaaaaaaaaaaaaaaaa",
      title: "Тема: склад",
      body: "## Суть\nТекст.",
      kind: "idea",
      status: "open",
      bindingId: BINDING,
      sectionId: "sec_aaaaaaaaaaaaaaaa",
      sectionLabel: "Плагины",
      sourceThreadId: "thr_irprd7iscv",
      relativePath: ideaRelativePath("ide_aaaaaaaaaaaaaaaaaaaaaaaa"),
      fileHash: null,
      revision: 1,
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(text).toContain("id: ide_aaaaaaaaaaaaaaaaaaaaaaaa");
    expect(text).toContain("title: \"Тема: склад\"");
    expect(text).toContain("section: Плагины");
    expect(text).toContain("# Тема: склад");
    expect(text).toContain("## Суть");
  });

  it("маршрутизирует CLI и принимает примеры", () => {
    expect(resolveAlias(["idea", "list"])).toBe("listIdeas");
    expect(resolveAlias(["ideas", "save"])).toBe("saveIdea");
    expect(resolveAlias(["idea", "get"])).toBe("getIdea");
    expect(resolveAlias(["idea", "status"])).toBe("setIdeaStatus");
    expect(listIdeasInputSchema.safeParse(null).success).toBe(true);
    expect(listIdeasInputSchema.safeParse(CLI_EXAMPLES.listIdeas).success).toBe(true);
    expect(CLI_OPERATIONS.listIdeas.input.safeParse(CLI_EXAMPLES.listIdeas).success).toBe(true);
    expect(saveIdeaInputSchema.safeParse(CLI_EXAMPLES.saveIdea).success).toBe(true);
    expect(CLI_OPERATIONS.saveIdea.input.safeParse(CLI_EXAMPLES.saveIdea).success).toBe(true);
    expect(resolveAlias(["idea", "thread"])).toBe("spawnIdeaThread");
    expect(spawnIdeaThreadInputSchema.safeParse(CLI_EXAMPLES.spawnIdeaThread).success).toBe(true);
  });

  it("собирает видимый spawn идеи и отклоняет пустое сообщение", () => {
    const idea = {
      id: "ide_aaaaaaaaaaaaaaaaaaaaaaaa",
      title: "Склад идей",
      body: "## Суть\nТекст.",
      kind: "idea" as const,
      status: "open" as const,
      bindingId: BINDING,
      sectionId: "sec_aaaaaaaaaaaaaaaa",
      sectionLabel: "Плагины",
      sourceThreadId: null,
      relativePath: ideaRelativePath("ide_aaaaaaaaaaaaaaaaaaaaaaaa"),
      fileHash: null,
      revision: 1,
      createdAt: NOW,
      updatedAt: NOW,
    };
    const empty = buildIdeaThreadSpawn(idea, {
      projectId: "proj_trusted",
      providerId: "claude-code",
      model: "claude-sonnet-4-6",
      reasoningLevel: "medium",
      permissionMode: "auto",
      environment: { type: "project-default" },
      input: [],
    });
    expect(empty.ok).toBe(false);
    const packed = buildIdeaThreadSpawn(idea, {
      projectId: "proj_trusted",
      providerId: "claude-code",
      model: "claude-sonnet-4-6",
      reasoningLevel: "medium",
      permissionMode: "auto",
      environment: { type: "project-default" },
      input: [{ type: "text", text: ideaThreadComposerPrompt(idea), mentions: [] }],
    });
    expect(packed.ok).toBe(true);
    if (!packed.ok) return;
    expect(packed.value.visibility).toBe("visible");
    expect(packed.value.title).toBe("Склад идей");
    expect(packed.value.sectionId).toBe("sec_aaaaaaaaaaaaaaaa");
    expect(packed.value.pluginMetadata.agencyIdeaId).toBe(idea.id);
    expect(packed.value.input).toHaveLength(2);
  });
});
