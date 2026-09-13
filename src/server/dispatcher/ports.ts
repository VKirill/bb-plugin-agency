import type { RunSnapshot } from "../../domain/models";

// A port, not an implementation. No spawn until the isolation milestone passes.
export interface RunLauncher {
  launch(run: RunSnapshot): Promise<{ threadId: string }>;
}
export interface Reconciler {
  reconcile(signal: AbortSignal): Promise<void>;
}
