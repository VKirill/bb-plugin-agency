import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { ownerAskToolInputSchema } from "../../../shared/contracts/owner-question";
import { cliFailure, encodeCliJson } from "../../cli/format.js";
import type { PresentOwnerQuestionDeps } from "./present.js";
import { presentOwnerQuestions } from "./present.js";

export function registerOwnerQuestionTool(bb: BbPluginApi, deps: PresentOwnerQuestionDeps): void {
  bb.agents.registerTool({
    name: "agency_ask_owner",
    description:
      "Open BB's native composer choice card so the owner clicks answers for Agency jobs waiting in this chat. Use instead of pasting A/B/C markdown. Optional questions: 1–4 items, each with a short header and 2–4 options. Wait until Send. Hidden Agency worker threads must not call this — they use report-needs-input.",
    instructions:
      "When Agency factory questions return to this chat, a choice card should open. If it does not, call agency_ask_owner and wait for Send. Do not retype options as 1A 2B. One card at a time.",
    parameters: ownerAskToolInputSchema,
    presentation: {
      label: { pending: "Waiting for the owner's click", completed: "Owner answered" },
      icon: { glyph: "Workflow" },
    },
    async execute(params, ctx) {
      const result = await presentOwnerQuestions(deps, {
        threadId: ctx.threadId,
        overlay: params,
        signal: ctx.signal,
      });
      if (!result.ok) {
        return { content: [{ type: "text", text: result.error }], isError: true };
      }
      if (result.cancelled) {
        return { content: [{ type: "text", text: "The owner cancelled the choice card. Do not invent answers." }], isError: true };
      }
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              answers: result.answers,
              appliedJobIds: result.applied,
              applyErrors: result.errors,
            }),
          },
        ],
      };
    },
  });
}

export async function presentOwnerQuestionsForCli(
  deps: PresentOwnerQuestionDeps,
  input: { threadId: string | null; overlay?: unknown; signal?: AbortSignal },
): Promise<{ exitCode: number; stdout: string; stderr?: string }> {
  if (!input.threadId) return cliFailure("invalid_command", "job ask-owner needs the calling BB thread");
  const result = await presentOwnerQuestions(deps, {
    threadId: input.threadId,
    overlay: input.overlay,
    signal: input.signal,
  });
  if (!result.ok) return cliFailure("owner_question_failed", result.error);
  return { exitCode: 0, stdout: encodeCliJson(result) };
}
