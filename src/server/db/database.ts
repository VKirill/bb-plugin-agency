import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { applyAgencyMigrations, migrations } from "./migrations";
import { enableForeignKeys, type SqlDatabase } from "./sql";

export type AgencyDatabase = SqlDatabase;

export function openDatabase(bb: BbPluginApi): AgencyDatabase {
  const db = bb.storage.database();
  enableForeignKeys(db);
  bb.storage.migrate(db, migrations);
  return db; // BB owns closing this handle on unload/reload.
}

export function openMigratedDatabase(db: SqlDatabase): SqlDatabase {
  enableForeignKeys(db);
  applyAgencyMigrations(db);
  return db;
}
