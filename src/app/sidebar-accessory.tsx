import { useCallback, useEffect, useRef, useState } from "react";
import {
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../shared/rpc-contract";
import { ruSkipProps, tr } from "./i18n";

export const EXECUTING_ACTIVITY_POLL_MS = 5_000;

function inProgressLabel(count: number): string {
  return tr("В работе: {count}", { count });
}

export function AgencySidebarAccessory() {
  const rpc = useRpc<typeof rpcContract>();
  const rpcRef = useRef(rpc);
  rpcRef.current = rpc;
  const connectionState = useRealtimeConnectionState();
  const requestState = useRef({
    isMounted: true,
    isRunning: false,
    refreshQueued: false,
  });
  const [count, setCount] = useState<number | null>(null);

  const refresh = useCallback(() => {
    const request = requestState.current;
    if (!request.isMounted) return;
    request.refreshQueued = true;
    if (request.isRunning) return;
    request.isRunning = true;

    void (async () => {
      try {
        while (request.isMounted && request.refreshQueued) {
          request.refreshQueued = false;
          try {
            const result = await rpcRef.current.call("sidebarInProgressJobCount");
            if (!request.isMounted) return;
            if (!result.available) setCount(null);
            else setCount(result.inProgressJobCount);
          } catch {
            if (request.isMounted) setCount(null);
          }
        }
      } finally {
        request.isRunning = false;
      }
    })();
  }, []);

  useEffect(() => {
    const request = requestState.current;
    request.isMounted = true;
    return () => {
      request.isMounted = false;
      request.refreshQueued = false;
    };
  }, []);

  useEffect(() => {
    if (connectionState === "connected") refresh();
  }, [connectionState, refresh]);
  useRealtime("domain-changed", refresh);

  useEffect(() => {
    const timer = setInterval(refresh, EXECUTING_ACTIVITY_POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  if (count === null || count === 0) return null;
  const label = inProgressLabel(count);
  return (
    <span {...ruSkipProps()} className="text-muted-foreground tabular-nums" title={label} aria-label={label}>
      {count}
    </span>
  );
}
