import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { rpcContract } from "../shared/rpc-contract";
import { openDatabase } from "./db/database";
import { createInbox } from "./inbox/store";
import { receiveNotification } from "./triggers/notify";
import { assessIsolation } from "./runtime/isolation";

export function registerAgency(bb: BbPluginApi) {
  const inbox = createInbox(openDatabase(bb));
  const status = () => ({ phase: "scaffold" as const,
    execution: "unavailable" as const,
    reason: assessIsolation().reason, inboxCount: inbox.count() });
  const notify = (input: unknown, source: "rpc" | "cli") => {
    const receipt = receiveNotification(inbox, input, source);
    if (!receipt.duplicate) bb.realtime.publish("inbox-changed", null);
    return receipt;
  };
  bb.rpc.register(rpcContract, { status, notify: input => notify(input, "rpc") });
  bb.cli.register({
    name: "agency", summary: "Каркас агентства: состояние и приём уведомлений",
    commands: [
      { name: "status", summary: "Состояние каркаса", usage: "bb agency status [--json]" },
      { name: "notify", summary: "Сохранить уведомление без запуска агента",
        usage: "bb agency notify <project-id> <event-id> <topic> <reference> [--json]" },
    ],
    async run(argv) {
      const json = argv.includes("--json");
      const [command, ...args] = argv.filter(arg => arg !== "--json");
      const usage = "bb agency status [--json]\nbb agency notify <project-id> <event-id> <topic> <reference> [--json]";
      if (!command || command === "help" || command === "--help") return { exitCode: 0, stdout: usage };
      try {
        if (command === "status" && args.length === 0) {
          const value = status();
          return { exitCode: 0, stdout: json ? JSON.stringify(value) : `${value.reason} Уведомлений: ${value.inboxCount}.` };
        }
        if (command === "notify" && args.length === 4) {
          const [projectId, eventId, topic, reference] = args;
          const receipt = notify({ projectId, eventId, topic, reference }, "cli");
          return { exitCode: 0, stdout: json ? JSON.stringify(receipt) :
            `${receipt.duplicate ? "Уже сохранено" : "Сохранено"}: ${receipt.eventId}. Агент не запускается.` };
        }
        return { exitCode: 1, stderr: usage };
      } catch (error) {
        return { exitCode: 1, stderr: error instanceof Error ? error.message : String(error) };
      }
    },
  });
  // No event listeners, schedules, tools or process launches at this milestone.
}
