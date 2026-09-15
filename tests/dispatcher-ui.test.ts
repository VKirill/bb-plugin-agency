import { describe, expect, it } from "vitest";
import {
  INTENT_APPROVE_HINT,
  INTENT_LAUNCH_UNAVAILABLE,
  INTENT_NO_SPAWN,
  dispatcherCommand,
  intentLaunchBlocked,
  intentsAwaitingApproval,
  nextIntentUiAction,
  catalogBbProjectId,
  catalogSharedBbBindingCount,
  ingestDraftAccepted,
  ingestDraftStorageKey,
  newDraftEventId,
  parseIngestDraft,
  readIngestDraft,
  writeIngestDraft,
  intentCatalogHeading,
  parseActionIntents,
  parseListedActionIntents,
  resolveCatalogBindingId,
  resolveWorkspaceProjectId,
} from "../src/app/data/dispatcher";
import { DISPATCHER_RPC } from "../src/app/data/methods";
import { createRpcAgencyApi } from "../src/app/data/rpc-agency-api";
import type { ActionIntentRecord } from "../src/shared/contracts";

const queued: ActionIntentRecord = {
  id: "ain_aaaaaaaa",
  matchId: "mtc_aaaaaaaa",
  uniqueKey: "inbox:rule:prepare_job",
  state: "queued",
  attemptCount: 1,
  revision: 1,
  fencingToken: null,
  fencingGeneration: 0,
  liveGate: false,
  jobId: null,
  lastError: "capability_unavailable",
};

const approval: ActionIntentRecord = {
  ...queued,
  id: "ain_bbbbbbbb",
  state: "awaiting_approval",
  lastError: null,
};

describe("dispatcher UI contract", () => {
  it("allowlist matches dispatcher-ui-contract names and no completeActionIntent", () => {
    expect(Object.values(DISPATCHER_RPC)).toEqual([
      "saveEventDefinition",
      "saveEventSource",
      "saveRuleVersion",
      "ingestInboxEvent",
      "dispatchTick",
      "listActionIntents",
      "listEventDefinitions",
      "listEventSources",
      "listRuleVersions",
      "claimActionIntent",
      "approveActionIntent",
    ]);
    expect(Object.values(DISPATCHER_RPC)).not.toContain("completeActionIntent");
    expect(Object.values(DISPATCHER_RPC)).not.toContain("notify");
  });

  it("queued is claim, approval is approve, launch stays blocked without jobId", () => {
    expect(nextIntentUiAction(queued)).toBe("claim");
    expect(nextIntentUiAction(approval)).toBe("approve");
    expect(intentLaunchBlocked(queued)).toBe(true);
    expect(intentLaunchBlocked(approval)).toBe(true);
    expect(intentsAwaitingApproval([queued, approval]).map((item) => item.id)).toEqual(["ain_bbbbbbbb"]);
  });

  it("parses typed intents and refuses unknown rows", () => {
    expect(parseActionIntents([queued])?.[0]?.jobId).toBeNull();
    expect(parseActionIntents([{ id: "nope" }])).toBeNull();
  });

  it("uses catalog join labels and does not invent a source title", () => {
    const listed = {
      ...queued,
      topic: "qa.root_observe",
      definitionLabel: "Наблюдение root",
      ruleId: "qa-root-observe",
      ruleLabel: "qa-root-observe",
      sourceId: "evs_aaaaaaaa",
      sourceKind: "notify",
      state: "observed" as const,
      lastError: null,
    };
    expect(parseListedActionIntents([listed])?.[0]?.definitionLabel).toBe("Наблюдение root");
    expect(intentCatalogHeading(listed)).toBe("Наблюдение root");
    expect(intentCatalogHeading({ ...listed, definitionLabel: null, ruleLabel: null })).toBe("Наблюдение");
  });

  it("tick and claim commands force live=false; approve needs expectedRevision from schema", () => {
    expect(dispatcherCommand.tick.parse({ requestId: "11111111-1111-4111-8111-111111111111" }).live).toBe(false);
    expect(dispatcherCommand.claim.parse({
      requestId: "11111111-1111-4111-8111-111111111111",
      intentId: "ain_aaaaaaaa",
      leaseOwner: "agency-ui",
    }).live).toBe(false);
    expect(dispatcherCommand.approve.safeParse({
      requestId: "11111111-1111-4111-8111-111111111111",
      intentId: "ain_aaaaaaaa",
    }).success).toBe(false);
    expect(INTENT_APPROVE_HINT).toMatch(/согласовано/);
    expect(INTENT_LAUNCH_UNAVAILABLE).toMatch(/запустить нельзя/);
    expect(INTENT_NO_SPAWN).toMatch(/запустить нельзя/);
  });

  it("rpc layer keeps live false on tick/claim and does not invent spawn", async () => {
    const calls: Array<{ method: string; input: unknown }> = [];
    const api = createRpcAgencyApi({
      call: async (method, input) => {
        calls.push({ method, input });
        if (method === "dispatchTick") {
          return { ok: true, value: { evaluated: 0, matched: 0, intents: 0, live: false, legacyInboxIgnored: true } };
        }
        if (method === "claimActionIntent") {
          return { ok: true, value: queued };
        }
        if (method === "listActionIntents") {
          return {
            ok: true,
            value: [{
              ...queued,
              topic: "qa.root_observe",
              definitionLabel: "Наблюдение root",
              ruleId: "qa-root-observe",
              ruleLabel: "qa-root-observe",
              sourceId: "evs_aaaaaaaa",
              sourceKind: "notify",
            }],
          };
        }
        throw new Error("unknown method");
      },
    });
    const tick = await api.dispatchTick({ requestId: "11111111-1111-4111-8111-111111111111", live: true, limit: 20 });
    expect(tick.ok).toBe(true);
    expect((calls[0]?.input as { live: boolean }).live).toBe(false);
    const claim = await api.claimActionIntent({
      requestId: "11111111-1111-4111-8111-111111111111",
      intentId: "ain_aaaaaaaa",
      live: true,
      leaseOwner: "agency-ui",
      leaseMs: 60_000,
    });
    expect(claim.ok).toBe(true);
    if (claim.ok) {
      expect(claim.value.jobId).toBeNull();
      expect(claim.value.lastError).toBe("capability_unavailable");
    }
    expect((calls[1]?.input as { live: boolean }).live).toBe(false);
    const listed = await api.listActionIntents({});
    expect(listed.ok && listed.value[0]?.jobId).toBeNull();
    expect(listed.ok && listed.value[0]?.definitionLabel).toBe("Наблюдение root");
  });

  it("resolves current workspace project to an existing id, never a free typed id", () => {
    const projects = [{ id: "bnd_current" }, { id: "bnd_other" }];
    expect(resolveWorkspaceProjectId(projects, "bnd_current")).toBe("bnd_current");
    expect(resolveWorkspaceProjectId(projects, "proj_typed_by_hand")).toBe("bnd_current");
    expect(resolveWorkspaceProjectId([], "proj_typed_by_hand")).toBe("");
  });

  it("maps binding id to bbProjectId and does not fall back to the first binding", () => {
    const projects = [
      { id: "bnd_aaaaaaaa", bbProjectId: "proj_7e4gc9rb6t" },
      { id: "bnd_bbbbbbbb", bbProjectId: "proj_otherxxxx" },
    ];
    expect(catalogBbProjectId(projects, "bnd_aaaaaaaa")).toBe("proj_7e4gc9rb6t");
    expect(catalogBbProjectId(projects, "proj_7e4gc9rb6t")).toBe("proj_7e4gc9rb6t");
    expect(catalogBbProjectId(projects, "proj_typed_by_hand")).toBe("");
    expect(resolveCatalogBindingId(projects, "proj_typed_by_hand")).toBe("");
    expect(catalogSharedBbBindingCount([
      { id: "bnd_aaaaaaaa", bbProjectId: "proj_7e4gc9rb6t" },
      { id: "bnd_bbbbbbbb", bbProjectId: "proj_7e4gc9rb6t" },
    ], "proj_7e4gc9rb6t")).toBe(2);
  });

  it("keeps the same eventId unless the draft was confirmed accepted", () => {
    const first = newDraftEventId();
    const second = newDraftEventId();
    expect(first).toMatch(/^evt_/);
    expect(first).not.toBe(second);
    expect(first).not.toBe("delivery-1");
    expect(ingestDraftAccepted({ ok: true, duplicate: false })).toBe(true);
    expect(ingestDraftAccepted({ ok: true, duplicate: true })).toBe(false);
    expect(ingestDraftAccepted({ ok: false })).toBe(false);
  });

  it("stores ingest draft per BB project and rejects another schema", () => {
    const storage = new Map<string, string>();
    const api = {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => { storage.set(key, value); },
    };
    const draft = {
      schema: 1 as const,
      eventId: "evt_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      sourceId: "evs_204ecd8616520806d5329f07",
      topic: "qa.root_observe",
      reference: "qa:catalog-mapping-436",
      body: "{}",
      accepted: false,
    };
    writeIngestDraft(api, "proj_7e4gc9rb6t", draft);
    expect(storage.has(ingestDraftStorageKey("proj_7e4gc9rb6t"))).toBe(true);
    expect(readIngestDraft(api, "proj_7e4gc9rb6t")?.eventId).toBe(draft.eventId);
    expect(readIngestDraft(api, "proj_otherxxxx")).toBeNull();
    expect(parseIngestDraft({ ...draft, schema: 2 })).toBeNull();
  });
});
