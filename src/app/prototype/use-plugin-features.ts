import { useEffect, useMemo, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../../shared/rpc-contract";
import { createRpcAgencyApi, type RpcCaller } from "../data/rpc-agency-api";

/** Agency features opened by installed BB plugins. */
export type PluginFeatures = { projectFolders: boolean; fileGateway: boolean };

const OFF: PluginFeatures = { projectFolders: false, fileGateway: false };
const TTL_MS = 60_000;
let cached: { at: number; value: Promise<PluginFeatures> } | null = null;

/** Test hook: forget the shared answer. */
export function resetPluginFeaturesCache(): void {
  cached = null;
}

/**
 * Which plugin features are on. One server call per minute for the whole page; until the
 * answer arrives, and in the demo, everything plugin-gated stays hidden.
 */
export function usePluginFeatures(enabled = true): PluginFeatures {
  const rpc = useRpc<typeof rpcContract>();
  const api = useMemo(() => createRpcAgencyApi(rpc as unknown as RpcCaller), [rpc]);
  const [features, setFeatures] = useState<PluginFeatures>(OFF);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    if (!cached || Date.now() - cached.at > TTL_MS) {
      cached = {
        at: Date.now(),
        value: api
          .listPlugins()
          .then((result) => (result.ok && result.value?.features ? result.value.features : OFF))
          .catch(() => OFF),
      };
    }
    void cached.value.then((value) => {
      if (live) setFeatures(value);
    });
    return () => {
      live = false;
    };
    // The client identity is not relied on: one answer is shared by the page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);
  return features;
}
