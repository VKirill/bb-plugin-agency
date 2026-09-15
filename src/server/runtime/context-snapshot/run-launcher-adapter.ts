import type { ContextSnapshot } from "./types.js";
import { RUN_LAUNCH_ADAPTER_CONTRACT } from "../run-store/launch-adapter-contract.js";

/**
 * Контракт адаптера launch. Persist — `createRunStore().reservePreparedRun`.
 * Spawn не реализован. executionAvailable = false.
 *
 * launchPreparedRun (будущий worker): сверка digest и host/cwd; CAS prepared→launching;
 * threadId затем launching→running; Job.running только после подтверждённого thread;
 * transport fail → failed, неопределённость → unknown; без авто-retry spawn.
 * Compiler snapshot не является auth.
 */
export type RunLauncherAdapterStatus = "not_implemented";

export type PersistContextSnapshotRequest = {
  snapshot: ContextSnapshot;
};

export type PersistContextSnapshotReceipt = {
  snapshotId: string;
  digest: string;
};

export type LaunchPreparedRunRequest = {
  snapshotId: string;
  digest: string;
};

export type RunLauncherAdapter = {
  readonly status: RunLauncherAdapterStatus;
  readonly executionAvailable: false;
  persistSnapshot(request: PersistContextSnapshotRequest): Promise<PersistContextSnapshotReceipt>;
  launchPreparedRun(request: LaunchPreparedRunRequest): Promise<never>;
};

export class RunLauncherAdapterNotImplementedError extends Error {
  readonly code = "run_launcher_not_implemented";

  constructor(operation: "persistSnapshot" | "launchPreparedRun") {
    super(`RunLauncher adapter is not implemented; ${operation} is a future persist/runtime boundary`);
    this.name = "RunLauncherAdapterNotImplementedError";
  }
}

export const runLauncherAdapter: RunLauncherAdapter = {
  status: "not_implemented",
  executionAvailable: RUN_LAUNCH_ADAPTER_CONTRACT.executionAvailable,
  persistSnapshot() {
    return Promise.reject(new RunLauncherAdapterNotImplementedError("persistSnapshot"));
  },
  launchPreparedRun() {
    return Promise.reject(new RunLauncherAdapterNotImplementedError("launchPreparedRun"));
  },
};
