import type { ProjectBinding } from "../../shared/contracts";
import type { IdeaItemView } from "../../shared/contracts/idea";
import { ideaProjectPath } from "./files";
import type { IdeaRecord } from "./store";

export function presentIdea(item: IdeaRecord, binding: ProjectBinding | undefined, fileWritten: boolean): IdeaItemView {
  return {
    ...item,
    fileWritten,
    bbProjectId: binding?.bbProjectId ?? null,
    hostId: binding?.hostId ?? null,
    projectPath: binding ? ideaProjectPath(binding, item.relativePath) : null,
  };
}
