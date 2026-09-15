import { z } from "zod";
import { opaqueIdSchema } from "./ids";

export const JOB_TEAM_MAX_IDS = 32;

export const jobTeamAgentIdsSchema = z.array(opaqueIdSchema).max(JOB_TEAM_MAX_IDS);

export function emptyJobTeamFields(): { reviewerAgentIds: string[]; observerAgentIds: string[] } {
  return { reviewerAgentIds: [], observerAgentIds: [] };
}

export type JobTeamFields = ReturnType<typeof emptyJobTeamFields>;
