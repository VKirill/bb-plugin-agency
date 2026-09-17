import { describe, it, expect } from "vitest";
import { createFakePluginHost, makeHostResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "../server";
import { statusSchema } from "../src/shared/schemas";

const signal = { projectId: "proj_test", eventId: "research-1", topic: "research.delivered", reference: "artifact-1" };

describe("agency notification scaffold", () => {
  it("exposes only machine identity to the prototype", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "agency", sdk: {
      hosts: { list: async () => [makeHostResponse({ id: "host-mini", name: "Mac mini" })] },
    }});
    try {
      await plugin(bb);
      expect(await harness.behavior.callRpc("uiContext", null)).toEqual({ hosts: [{id:"host-mini",name:"Mac mini"}], primaryHostId: null });
      expect(harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(0);
    } finally { await harness.lifecycle.dispose(); }
  });
  it("persists through reload without starting workers", async () => {
    let { bb, harness } = createFakePluginHost({ pluginId: "agency" });
    try {
      await plugin(bb);
      expect(await harness.behavior.callRpc("notify", signal)).toMatchObject({ accepted: true, duplicate: false, execution: "unavailable" });
      ({ bb, harness } = await harness.lifecycle.reload(plugin));
      const status = statusSchema.parse(await harness.behavior.callRpc("status", null));
      expect(status).toMatchObject({
        inboxCount: 1,
        phase: "runtime",
        execution: "requires_readiness",
      });
      expect(status.reason).toMatch(/getIsolationReadiness/);
      expect(await harness.behavior.callRpc("notify", signal)).toMatchObject({ duplicate: true });
      expect(harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(0);
    } finally { await harness.lifecycle.dispose(); }
  });
  it("deduplicates across CLI/RPC but refuses conflicting content", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "agency" });
    try {
      await plugin(bb);
      const first = await harness.behavior.runCli(["notify", signal.projectId, signal.eventId, signal.topic, signal.reference, "--json"]);
      expect(first.exitCode).toBe(0);
      expect(await harness.behavior.callRpc("notify", signal)).toMatchObject({ duplicate: true });
      const conflict = await harness.behavior.runCli(["notify", signal.projectId, signal.eventId, signal.topic, "other-artifact"]);
      expect(conflict.exitCode).toBe(1);
      expect(await harness.behavior.callRpc("status", null)).toMatchObject({ inboxCount: 1 });
      await harness.behavior.callRpc("notify", { ...signal, projectId: "another-project" });
      expect(await harness.behavior.callRpc("status", null)).toMatchObject({ inboxCount: 2 });
    } finally { await harness.lifecycle.dispose(); }
  });
  it("rejects extra fields and invalid topics", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "agency" });
    try {
      await plugin(bb);
      await expect(harness.behavior.callRpc("notify", { ...signal, instructions: "run anything" })).rejects.toThrow();
      await expect(harness.behavior.callRpc("notify", { ...signal, topic: "bad topic" })).rejects.toThrow();
      expect(await harness.behavior.callRpc("status", null)).toMatchObject({ inboxCount: 0 });
    } finally { await harness.lifecycle.dispose(); }
  });
});
