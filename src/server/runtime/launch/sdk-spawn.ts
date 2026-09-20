import type {
  LaunchContract,
  ReconcileOutcome,
  SpawnOutcome,
  SpawnPort,
  ThreadVerifyOutcome,
  ThreadVerifyPort,
} from "./ports.js";

/** A spawn port that never calls `threads.spawn`: for a coordinator with no live SDK wired. */
export function unsupportedSdkSpawnPort(): SpawnPort {
  return {
    supported: false,
    async spawn(_request: LaunchContract): Promise<SpawnOutcome> {
      return {
        kind: "rejected",
        code: "sdk_spawn_unsupported",
        message: "no live threads.spawn is wired; spawn is not called",
      };
    },
    async reconcileByLaunchId(_launchId: string): Promise<ReconcileOutcome> {
      return { kind: "unsupported" };
    },
  };
}

/** No live thread lookup is wired. Do not invent confirmation. */
export function unsupportedSdkThreadVerifyPort(): ThreadVerifyPort {
  return {
    supported: false,
    async verifyConfirmedThread(): Promise<ThreadVerifyOutcome> {
      return {
        kind: "unavailable",
        code: "sdk_thread_lookup_unsupported",
        message:
          "no live thread lookup is wired to prove launch identity; recovery stays pending",
      };
    },
  };
}
