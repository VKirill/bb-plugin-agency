import { fail, type DomainResult } from "../../domain";
import type { RuleAction } from "../../shared/contracts";

/** Prepare/launch from dispatcher. Default implementation is unavailable until shared integration. */
export type DispatcherLaunchPort = {
  enqueueLaunch(input: {
    intentId: string;
    action: RuleAction;
    fencingToken: string;
    fencingGeneration: number;
    launchId: string;
  }): Promise<DomainResult<{ jobId: string | null; launchId: string | null }>>;
};

export type DispatcherPreparePort = DispatcherLaunchPort;

export function unavailableDispatcherLaunchPort(): DispatcherLaunchPort {
  return {
    async enqueueLaunch() {
      return fail("capability_unavailable", "dispatcher launch port is unavailable until shared integration");
    },
  };
}

export { unavailableDispatcherLaunchPort as unavailableDispatcherPreparePort };
