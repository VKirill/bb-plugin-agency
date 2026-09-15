import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { hostEntryHandlers } from "./src/host/entry-handlers";
import { documentHostContract } from "./src/shared/document-contract";

export default experimental_defineHostEntry({
  contract: documentHostContract,
  handlers: hostEntryHandlers,
});
