import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { resolveAlias } from "../src/server/cli/aliases";
import { CLI_EXAMPLES } from "../src/server/cli/examples";
import { CLI_OPERATIONS } from "../src/server/cli/operations";
import { openMigratedDatabase } from "../src/server/db";
import { buildDigest, listOwnerMessages, markOwnerMessagesRead, recordOwnerMessage, scriptTemplates } from "../src/server/owner-messages/service";
import { createJobCommandSchema } from "../src/shared/contracts/job";
import { seed } from "./role-types.test";

const NOW = "2026-09-17T12:00:00.000Z";

describe("messages to the owner", () => {
  it("stores a message once per dedupe key and tracks unread", () => {
    const db = openMigratedDatabase(new Database(":memory:"));
    const first = recordOwnerMessage(db, { text: " Выгрузка не пришла ", level: "warning", dedupeKey: "export:2026-09-17" }, "owner", NOW);
    expect(first.ok && first.value.duplicate).toBe(false);
    const again = recordOwnerMessage(db, { text: "Выгрузка не пришла", dedupeKey: "export:2026-09-17" }, "owner", NOW);
    expect(again.ok && again.value.duplicate).toBe(true);
    recordOwnerMessage(db, { text: "Сводка" }, "digest:summary", "2026-09-17T13:00:00.000Z");
    const listed = listOwnerMessages(db);
    expect(listed.unread).toBe(2);
    expect(listed.messages.map((message) => [message.text, message.level, message.telegram])).toEqual([
      ["Сводка", "info", "off"],
      ["Выгрузка не пришла", "warning", "off"],
    ]);
    expect(markOwnerMessagesRead(db, [listed.messages[0]!.id], NOW)).toBe(1);
    expect(listOwnerMessages(db).unread).toBe(1);
    expect(markOwnerMessagesRead(db, undefined, NOW)).toBe(1);
    expect(listOwnerMessages(db).unread).toBe(0);
    expect(recordOwnerMessage(db, { text: "   " }, "owner", NOW).ok).toBe(false);
  });

  it("builds a summary and a watchdog from the jobs", () => {
    const db = openMigratedDatabase(new Database(":memory:"));
    const s = seed(db);
    const job = (title: string) => {
      const created = s.store.createJob(s.ctx, createJobCommandSchema.parse({ requestId: randomUUID(), bindingId: s.ctx.allowedBindingIds[0], departmentId: s.departmentId, title, brief: "Б.", acceptance: "К.", assignedAgentId: s.developer }));
      if (!created.ok) throw new Error(created.error.message);
      return created.value;
    };
    const stuck = job("Застряла");
    const fresh = job("Свежая");
    db.prepare(`UPDATE agency_job SET state = 'blocked', updated_at = ? WHERE id = ?`).run("2026-09-15T12:00:00.000Z", stuck.id);
    db.prepare(`UPDATE agency_job SET state = 'waiting_input', updated_at = ? WHERE id = ?`).run("2026-09-17T11:00:00.000Z", fresh.id);
    const now = new Date(NOW);

    const watchdog = buildDigest(db, { kind: "watchdog", sinceHours: 24, stuckHours: 12 }, now, false);
    expect(watchdog.level).toBe("warning");
    expect(watchdog.text).toBe(`Сторож: 1 задач ждут дольше 12 ч.\n- ${stuck.key} «Застряла» — ожидает решения`);
    expect(buildDigest(db, { kind: "watchdog", sinceHours: 24, stuckHours: 100 }, now, true).text).toBe("Watchdog: nothing waits longer than 100 h.");

    const summary = buildDigest(db, { kind: "summary", sinceHours: 24, stuckHours: 24 }, now, false);
    expect(summary.counts).toMatchObject({ waitingInput: 1, blocked: 1 });
    expect(summary.text.split("\n")[1]).toBe("Сейчас: в работе 0, ждут проверки 0, вашего ответа 1, решения 1.");
    expect(summary.text).toContain(`- ${fresh.key} «Свежая» — ждёт вашего ответа`);
  });

  it("is reachable from the CLI with examples, and ships script templates that use it", () => {
    expect(resolveAlias(["notify-owner"])).toBe("notifyOwner");
    expect(resolveAlias(["digest"])).toBe("ownerDigest");
    expect(resolveAlias(["scripts"])).toBe("listScriptTemplates");
    expect(resolveAlias(["owner", "messages"])).toBe("listOwnerMessages");
    expect(resolveAlias(["owner", "read"])).toBe("markOwnerMessagesRead");
    for (const operation of ["notifyOwner", "ownerDigest", "listOwnerMessages", "markOwnerMessagesRead", "listScriptTemplates"] as const) {
      expect(CLI_OPERATIONS[operation].input.safeParse(CLI_EXAMPLES[operation]).success).toBe(true);
    }
    const templates = scriptTemplates(false);
    expect(templates.map((item) => item.id)).toEqual(["daily-summary", "watchdog", "recurring-job"]);
    const digestCall = /bb agency digest --input-json '(\{.*\})'/;
    for (const template of templates.slice(0, 2)) {
      const json = digestCall.exec(template.script)?.[1];
      expect(CLI_OPERATIONS.ownerDigest.input.safeParse(JSON.parse(json!)).success).toBe(true);
    }
    expect(templates[2]!.script).toContain("bb agency launch queue");
    expect(templates.map((item) => item.script).join("\n")).not.toMatch(/\/Users\/|\/home\//);
  });
});
