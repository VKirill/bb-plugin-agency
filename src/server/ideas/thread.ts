import { fail, ok, type DomainResult } from "../../domain";
import { ideaThreadAgentBrief } from "../../shared/idea-thread";
import type { IdeaComposerRequest } from "../../shared/contracts/idea";
import type { IdeaRecord } from "./store";

export type IdeaThreadSpawnArgs = IdeaComposerRequest & {
  title: string;
  visibility: "visible";
  sectionId?: string;
  pluginMetadata: { agencyIdeaId: string };
  input: unknown[];
};

export function buildIdeaThreadSpawn(
  idea: IdeaRecord,
  request: IdeaComposerRequest,
): DomainResult<IdeaThreadSpawnArgs> {
  if (!Array.isArray(request.input) || request.input.length === 0) {
    return fail("invalid_input", "new thread needs a first message");
  }
  return ok({
    ...request,
    title: idea.title,
    visibility: "visible",
    ...(idea.sectionId ? { sectionId: idea.sectionId } : {}),
    pluginMetadata: { agencyIdeaId: idea.id },
    input: [
      ...request.input,
      { type: "text", text: ideaThreadAgentBrief(idea), mentions: [], visibility: "agent-only" },
    ],
  });
}
