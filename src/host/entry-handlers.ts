import type { ExperimentalHostRpcHandlers } from "@get-bb/plugin-sdk";
import { materializeDocument } from "../server/runtime/document-files";
import { documentHostContract } from "../shared/document-contract";
import { handleHostFileOp } from "./file-handlers";

export const hostEntryHandlers: ExperimentalHostRpcHandlers<typeof documentHostContract> = {
  materialize: (input, context) =>
    materializeDocument(input, context.experimental_paths.dataDir, context.signal),
  fileOp: (input, _context) => handleHostFileOp(input),
};
