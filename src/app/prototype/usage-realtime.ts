import { useRealtime } from "@get-bb/plugin-sdk/app";
import { USAGE_REALTIME_CHANNELS } from "../data/usage-dashboard";

export function useUsageRealtime(refresh: () => void) {
  useRealtime(USAGE_REALTIME_CHANNELS[0], refresh);
  useRealtime(USAGE_REALTIME_CHANNELS[1], refresh);
}
