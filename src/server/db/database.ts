import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { migrations } from "./migrations";

export type AgencyDatabase = ReturnType<BbPluginApi["storage"]["database"]>;
export function openDatabase(bb: BbPluginApi): AgencyDatabase {
  const db = bb.storage.database();
  bb.storage.migrate(db, migrations);
  return db; // BB owns closing this handle on unload/reload.
}
