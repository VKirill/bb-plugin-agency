/** @vitest-environment happy-dom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { DispatcherApi } from "../src/app/data/dispatcher";
import { DISPATCHER_NO_BB_PROJECT, DISPATCHER_SHARED_BB_SCOPE, INGEST_SOURCE_GONE, INTENT_LAUNCH_UNAVAILABLE, writeIngestDraft } from "../src/app/data/dispatcher";
import { DispatcherAutomationsPage } from "../src/app/prototype/dispatcher-automations";
import { InboxPage } from "../src/app/prototype/inbox";
import type { Job } from "../src/app/prototype/data";

vi.mock("@get-bb/plugin-sdk/app", () => ({
  experimental_useProviders: () => ({ providers: [] }),
  experimental_ProviderIcon: () => null,
}));

const catalogJoin = {
  topic: null as string | null,
  definitionLabel: null as string | null,
  ruleId: null as string | null,
  ruleLabel: null as string | null,
  sourceId: null as string | null,
  sourceKind: null as string | null,
};

const queued = {
  id: "ain_aaaaaaaa",
  matchId: "mtc_aaaaaaaa",
  uniqueKey: "k",
  state: "queued" as const,
  attemptCount: 1,
  revision: 1,
  fencingToken: null,
  fencingGeneration: 0,
  liveGate: false,
  jobId: null,
  lastError: "capability_unavailable",
  ...catalogJoin,
  topic: "research.delivered",
  definitionLabel: "Поставка исследования",
  ruleLabel: "research-review",
  ruleId: "research-review",
  sourceKind: "notify",
};

const liveBinding = {
  id: "bnd_aaaaaaaa",
  name: "BB-сервис",
  bbProjectId: "proj_7e4gc9rb6t",
};

const liveSource = {
  id: "evs_204ecd8616520806d5329f07",
  projectId: "proj_7e4gc9rb6t",
  kind: "notify",
  enabled: true,
};

const emptyCatalog = {
  listEventDefinitions: vi.fn(async () => ({ ok: true as const, value: [] })),
  listEventSources: vi.fn(async () => ({ ok: true as const, value: [] })),
  listRuleVersions: vi.fn(async () => ({ ok: true as const, value: [] })),
};

const approval = {
  ...queued,
  id: "ain_bbbbbbbb",
  state: "awaiting_approval" as const,
  lastError: null,
};

/** Radix TabsTrigger activates on pointerdown, not HTMLElement.click() alone. */
function pressTab(node: Element | null) {
  if (!(node instanceof HTMLElement)) return;
  const opts = { bubbles: true, cancelable: true, composed: true, button: 0, pointerId: 1, pointerType: "mouse" as const };
  node.dispatchEvent(new PointerEvent("pointerdown", opts));
  node.dispatchEvent(new MouseEvent("mousedown", opts));
  node.dispatchEvent(new PointerEvent("pointerup", opts));
  node.dispatchEvent(new MouseEvent("mouseup", opts));
  node.dispatchEvent(new MouseEvent("click", opts));
}

function job(id: string, state: Job["state"]): Job {
  return {
    id,
    title: id,
    state,
    sourceState: state,
    project: "P",
    department: "D",
    agent: "A",
    priority: "Обычный",
    due: "",
    description: "d",
    comments: [],
  };
}

describe("dispatcher pages", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    sessionStorage.clear();
  });

  it("lists typed intents, does not promise spawn, approve uses intent.revision", async () => {
    const claim = vi.fn(async () => ({ ok: true as const, value: queued }));
    const approve = vi.fn(async () => ({ ok: true as const, value: { ...approval, state: "queued" as const } }));
    const api = {
      listActionIntents: vi.fn(async () => ({ ok: true as const, value: [queued, approval] })),
      ...emptyCatalog,
      claimActionIntent: claim,
      approveActionIntent: approve,
      saveEventDefinition: vi.fn(),
      saveEventSource: vi.fn(),
      saveRuleVersion: vi.fn(),
      ingestInboxEvent: vi.fn(),
      dispatchTick: vi.fn(),
    } as unknown as DispatcherApi;
    const notices: string[] = [];
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root: Root = createRoot(container);
    await act(async () => {
      root.render(createElement(DispatcherAutomationsPage, {
        api,
        projects: [{ id: "bnd_current", name: "BB-сервис" }],
        projectId: "bnd_current",
        departments: [],
        notice: (text) => { notices.push(text); },
      }) as ReactNode);
    });
    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="dispatcher-intent-ain_aaaaaaaa"]')).toBeTruthy();
    });
    expect(container.textContent).toContain("Поставка исследования");
    expect(container.textContent).toContain(INTENT_LAUNCH_UNAVAILABLE);
    expect(container.textContent).toContain("Взять в работу");
    expect(container.textContent).toContain("Согласовать");
    expect(container.textContent).not.toMatch(/агент запущен|правило включено|Взять lease|Записать definition|RPC не вызываем|sourceId|body JSON|не выдумываются/i);
    await act(async () => {
      container.querySelector('[data-testid="dispatcher-approve-ain_bbbbbbbb"]')?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await vi.waitFor(() => expect(approve).toHaveBeenCalled());
    expect(approve).toHaveBeenCalledWith(expect.objectContaining({ expectedRevision: 1 }));
    await act(async () => {
      container.querySelector('[data-testid="dispatcher-claim-ain_aaaaaaaa"]')?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await vi.waitFor(() => expect(claim).toHaveBeenCalled());
    expect(claim).toHaveBeenCalledWith(expect.objectContaining({ live: false }));
    await act(async () => { root.unmount(); });
  });

  it("picks workspace project by label and sends that exact id, not a free typed id", async () => {
    const saveEventSource = vi.fn(async () => ({
      ok: true as const,
      value: { id: "evs_aaaaaaaa", projectId: "proj_7e4gc9rb6t", kind: "notify", enabled: true },
    }));
    const api = {
      listActionIntents: vi.fn(async () => ({ ok: true as const, value: [] })),
      ...emptyCatalog,
      saveEventSource,
      saveEventDefinition: vi.fn(),
      saveRuleVersion: vi.fn(),
      ingestInboxEvent: vi.fn(),
      dispatchTick: vi.fn(),
      claimActionIntent: vi.fn(),
      approveActionIntent: vi.fn(),
    } as unknown as DispatcherApi;
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root: Root = createRoot(container);
    await act(async () => {
      root.render(createElement(DispatcherAutomationsPage, {
        api,
        projects: [liveBinding, { id: "bnd_bbbbbbbb", name: "Другой", bbProjectId: "proj_otherxxxx" }],
        projectId: "proj_7e4gc9rb6t",
        departments: [],
        notice: () => undefined,
      }) as ReactNode);
    });
    await act(async () => {
      pressTab(container.querySelector('[data-testid="dispatcher-tab-Источники"]'));
    });
    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="dispatcher-save-source"]')).toBeTruthy();
    });
    expect(container.querySelector('input[value="proj_7e4gc9rb6t"]')).toBeNull();
    expect(container.querySelector('[aria-label="Проект"]')?.textContent).toContain("BB-сервис");
    await act(async () => {
      container.querySelector('[data-testid="dispatcher-save-source"]')?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await vi.waitFor(() => expect(saveEventSource).toHaveBeenCalled());
    expect(saveEventSource).toHaveBeenCalledWith(expect.objectContaining({ projectId: "proj_7e4gc9rb6t" }));
    expect(saveEventSource).not.toHaveBeenCalledWith(expect.objectContaining({ projectId: "bnd_aaaaaaaa" }));
    expect(container.querySelector('[data-testid="dispatcher-ingest"]')).toBeNull();
    await act(async () => {
      pressTab(container.querySelector('[data-testid="dispatcher-tab-События"]'));
    });
    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="dispatcher-ingest"]')).toBeTruthy();
    });
    expect(container.textContent).toMatch(/Код источника/);
    await act(async () => { root.unmount(); });
  });

  it("sends catalog source, topic and ruleId exactly and does not invent a source title", async () => {
    const ingest = vi.fn(async () => ({
      ok: true as const,
      value: {
        id: "iev_aaaaaaaa",
        sourceId: liveSource.id,
        projectId: "proj_7e4gc9rb6t",
        eventId: "delivery-1",
        topic: "qa.root_observe",
        bodyDigest: "digest",
        state: "accepted" as const,
        duplicate: false,
        depth: 0,
      },
    }));
    const saveRule = vi.fn(async () => ({
      ok: true as const,
      value: {
        id: "rlv_aaaaaaaa",
        ruleId: "qa-root-observe",
        version: 1,
        projectId: "proj_7e4gc9rb6t",
        topic: "qa.root_observe",
        mode: "observe" as const,
        enabled: true,
      },
    }));
    const listEventSources = vi.fn(async () => ({
      ok: true as const,
      value: [liveSource],
    }));
    const api = {
      listActionIntents: vi.fn(async () => ({ ok: true as const, value: [] })),
      listEventDefinitions: vi.fn(async () => ({
        ok: true as const,
        value: [{ topic: "qa.root_observe", schemaVersion: 1, namespace: "agency" as const, label: "Наблюдение root" }],
      })),
      listEventSources,
      listRuleVersions: vi.fn(async () => ({
        ok: true as const,
        value: [{
          id: "rlv_aaaaaaaa",
          ruleId: "qa-root-observe",
          version: 1,
          projectId: "proj_7e4gc9rb6t",
          topic: "qa.root_observe",
          mode: "observe" as const,
          enabled: true,
          label: "qa-root-observe",
          sourceId: null,
        }],
      })),
      ingestInboxEvent: ingest,
      saveRuleVersion: saveRule,
      saveEventDefinition: vi.fn(),
      saveEventSource: vi.fn(),
      dispatchTick: vi.fn(),
      claimActionIntent: vi.fn(),
      approveActionIntent: vi.fn(),
    } as unknown as DispatcherApi;
    const container = document.body.appendChild(document.createElement("div"));
    const root: Root = createRoot(container);
    await act(async () => {
      root.render(createElement(DispatcherAutomationsPage, {
        api,
        projects: [liveBinding],
        projectId: "bnd_aaaaaaaa",
        departments: [],
        notice: () => undefined,
      }) as ReactNode);
    });
    await vi.waitFor(() => {
      expect(listEventSources).toHaveBeenCalledWith({ projectId: "proj_7e4gc9rb6t" });
    });
    expect(listEventSources).not.toHaveBeenCalledWith({ projectId: "bnd_aaaaaaaa" });
    await act(async () => {
      pressTab(container.querySelector('[data-testid="dispatcher-tab-События"]'));
    });
    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="dispatcher-ingest"]')).toBeTruthy();
    });
    expect(container.textContent).toContain(`Уведомление · ${liveSource.id}`);
    expect(container.textContent).not.toMatch(/Источник уведомлений|Код источника/i);
    await act(async () => {
      container.querySelector('[data-testid="dispatcher-ingest"]')?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await vi.waitFor(() => expect(ingest).toHaveBeenCalled());
    expect(ingest).toHaveBeenCalledWith(expect.objectContaining({
      sourceId: liveSource.id,
      topic: "qa.root_observe",
    }));
    await act(async () => {
      pressTab(container.querySelector('[data-testid="dispatcher-tab-Правила"]'));
    });
    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="dispatcher-save-rule"]')).toBeTruthy();
    });
    await act(async () => {
      container.querySelector('[data-testid="dispatcher-save-rule"]')?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await vi.waitFor(() => expect(saveRule).toHaveBeenCalled());
    expect(saveRule).toHaveBeenCalledWith(expect.objectContaining({
      ruleId: "qa-root-observe",
      topic: "qa.root_observe",
      projectId: "proj_7e4gc9rb6t",
    }));
    expect(saveRule).not.toHaveBeenCalledWith(expect.objectContaining({ projectId: "bnd_aaaaaaaa" }));
    await act(async () => { root.unmount(); });
  });

  it("disables source save when binding has no bbProjectId", async () => {
    const saveEventSource = vi.fn();
    const listEventSources = vi.fn();
    const api = {
      listActionIntents: vi.fn(async () => ({ ok: true as const, value: [] })),
      listEventDefinitions: vi.fn(async () => ({ ok: true as const, value: [] })),
      listEventSources,
      listRuleVersions: vi.fn(async () => ({ ok: true as const, value: [] })),
      saveEventSource,
      saveEventDefinition: vi.fn(),
      saveRuleVersion: vi.fn(),
      ingestInboxEvent: vi.fn(),
      dispatchTick: vi.fn(),
      claimActionIntent: vi.fn(),
      approveActionIntent: vi.fn(),
    } as unknown as DispatcherApi;
    const container = document.body.appendChild(document.createElement("div"));
    const root: Root = createRoot(container);
    await act(async () => {
      root.render(createElement(DispatcherAutomationsPage, {
        api,
        projects: [{ id: "bnd_aaaaaaaa", name: "BB-сервис" }],
        projectId: "bnd_aaaaaaaa",
        departments: [],
        notice: () => undefined,
      }) as ReactNode);
    });
    await act(async () => {
      pressTab(container.querySelector('[data-testid="dispatcher-tab-Источники"]'));
    });
    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="dispatcher-save-source"]')).toBeTruthy();
    });
    expect(container.textContent).toContain(DISPATCHER_NO_BB_PROJECT);
    expect(container.querySelector('[data-testid="dispatcher-save-source"]')).toHaveProperty("disabled", true);
    expect(listEventSources).not.toHaveBeenCalled();
    await act(async () => {
      container.querySelector('[data-testid="dispatcher-save-source"]')?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(saveEventSource).not.toHaveBeenCalled();
    await act(async () => { root.unmount(); });
  });

  it("does not promise isolation when two bindings share one BB project", async () => {
    const listEventSources = vi.fn(async () => ({ ok: true as const, value: [liveSource] }));
    const api = {
      listActionIntents: vi.fn(async () => ({ ok: true as const, value: [] })),
      listEventDefinitions: vi.fn(async () => ({ ok: true as const, value: [] })),
      listEventSources,
      listRuleVersions: vi.fn(async () => ({ ok: true as const, value: [] })),
      saveEventSource: vi.fn(),
      saveEventDefinition: vi.fn(),
      saveRuleVersion: vi.fn(),
      ingestInboxEvent: vi.fn(),
      dispatchTick: vi.fn(),
      claimActionIntent: vi.fn(),
      approveActionIntent: vi.fn(),
    } as unknown as DispatcherApi;
    const container = document.body.appendChild(document.createElement("div"));
    const root: Root = createRoot(container);
    await act(async () => {
      root.render(createElement(DispatcherAutomationsPage, {
        api,
        projects: [
          liveBinding,
          { id: "bnd_bbbbbbbb", name: "Копия", bbProjectId: "proj_7e4gc9rb6t" },
        ],
        projectId: "bnd_aaaaaaaa",
        departments: [],
        notice: () => undefined,
      }) as ReactNode);
    });
    await vi.waitFor(() => {
      expect(listEventSources).toHaveBeenCalledWith({ projectId: "proj_7e4gc9rb6t" });
    });
    expect(container.textContent).toContain(DISPATCHER_SHARED_BB_SCOPE);
    await act(async () => { root.unmount(); });
  });

  it("sends two different eventIds only after an explicit next event", async () => {
    const ingest = vi.fn(async (input: { eventId: string }) => ({
      ok: true as const,
      value: {
        id: "iev_aaaaaaaa",
        sourceId: liveSource.id,
        projectId: "proj_7e4gc9rb6t",
        eventId: input.eventId,
        topic: "qa.root_observe",
        bodyDigest: "digest",
        state: "accepted" as const,
        duplicate: false,
        depth: 0,
      },
    }));
    const api = {
      listActionIntents: vi.fn(async () => ({ ok: true as const, value: [] })),
      listEventDefinitions: vi.fn(async () => ({ ok: true as const, value: [] })),
      listEventSources: vi.fn(async () => ({ ok: true as const, value: [liveSource] })),
      listRuleVersions: vi.fn(async () => ({ ok: true as const, value: [] })),
      ingestInboxEvent: ingest,
      saveEventDefinition: vi.fn(),
      saveEventSource: vi.fn(),
      saveRuleVersion: vi.fn(),
      dispatchTick: vi.fn(),
      claimActionIntent: vi.fn(),
      approveActionIntent: vi.fn(),
    } as unknown as DispatcherApi;
    const container = document.body.appendChild(document.createElement("div"));
    const root: Root = createRoot(container);
    await act(async () => {
      root.render(createElement(DispatcherAutomationsPage, {
        api,
        projects: [liveBinding],
        projectId: "bnd_aaaaaaaa",
        departments: [],
        notice: () => undefined,
      }) as ReactNode);
    });
    await act(async () => {
      pressTab(container.querySelector('[data-testid="dispatcher-tab-События"]'));
    });
    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="dispatcher-ingest"]')).toBeTruthy();
    });
    await act(async () => {
      container.querySelector('[data-testid="dispatcher-ingest"]')?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      container.querySelector('[data-testid="dispatcher-ingest"]')?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await vi.waitFor(() => expect(ingest).toHaveBeenCalledTimes(1));
    const firstId = (ingest.mock.calls[0]![0] as { eventId: string }).eventId;
    expect(firstId).toMatch(/^evt_/);
    expect(firstId).not.toBe("delivery-1");
    expect(container.querySelector('[data-testid="dispatcher-next-event"]')).toBeTruthy();
    await act(async () => {
      container.querySelector('[data-testid="dispatcher-ingest"]')?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(ingest).toHaveBeenCalledTimes(1);
    await act(async () => {
      container.querySelector('[data-testid="dispatcher-next-event"]')?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await act(async () => {
      container.querySelector('[data-testid="dispatcher-ingest"]')?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await vi.waitFor(() => expect(ingest).toHaveBeenCalledTimes(2));
    const secondId = (ingest.mock.calls[1]![0] as { eventId: string }).eventId;
    expect(secondId).toMatch(/^evt_/);
    expect(secondId).not.toBe(firstId);
    await act(async () => { root.unmount(); });
  });

  it("retries the same eventId on duplicate and unknown without rotating identity", async () => {
    const ingest = vi.fn()
      .mockResolvedValueOnce({ ok: false as const, failure: { kind: "unavailable" as const, message: "hold" } })
      .mockResolvedValueOnce({
        ok: true as const,
        value: {
          id: "iev_aaaaaaaa",
          sourceId: liveSource.id,
          projectId: "proj_7e4gc9rb6t",
          eventId: "kept",
          topic: "qa.root_observe",
          bodyDigest: "digest",
          state: "accepted" as const,
          duplicate: true,
          depth: 0,
        },
      })
      .mockResolvedValueOnce({
        ok: true as const,
        value: {
          id: "iev_aaaaaaaa",
          sourceId: liveSource.id,
          projectId: "proj_7e4gc9rb6t",
          eventId: "kept",
          topic: "qa.root_observe",
          bodyDigest: "digest",
          state: "accepted" as const,
          duplicate: true,
          depth: 0,
        },
      });
    const api = {
      listActionIntents: vi.fn(async () => ({ ok: true as const, value: [] })),
      listEventDefinitions: vi.fn(async () => ({ ok: true as const, value: [] })),
      listEventSources: vi.fn(async () => ({ ok: true as const, value: [liveSource] })),
      listRuleVersions: vi.fn(async () => ({ ok: true as const, value: [] })),
      ingestInboxEvent: ingest,
      saveEventDefinition: vi.fn(),
      saveEventSource: vi.fn(),
      saveRuleVersion: vi.fn(),
      dispatchTick: vi.fn(),
      claimActionIntent: vi.fn(),
      approveActionIntent: vi.fn(),
    } as unknown as DispatcherApi;
    const container = document.body.appendChild(document.createElement("div"));
    const root: Root = createRoot(container);
    await act(async () => {
      root.render(createElement(DispatcherAutomationsPage, {
        api,
        projects: [liveBinding],
        projectId: "bnd_aaaaaaaa",
        departments: [],
        notice: () => undefined,
      }) as ReactNode);
    });
    await act(async () => {
      pressTab(container.querySelector('[data-testid="dispatcher-tab-События"]'));
    });
    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="dispatcher-ingest"]')).toBeTruthy();
    });
    await act(async () => {
      container.querySelector('[data-testid="dispatcher-ingest"]')?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await vi.waitFor(() => expect(ingest).toHaveBeenCalledTimes(1));
    await act(async () => {
      container.querySelector('[data-testid="dispatcher-ingest"]')?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await vi.waitFor(() => expect(ingest).toHaveBeenCalledTimes(2));
    await act(async () => {
      container.querySelector('[data-testid="dispatcher-ingest"]')?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await vi.waitFor(() => expect(ingest).toHaveBeenCalledTimes(3));
    const ids = ingest.mock.calls.map((call) => (call[0] as { eventId: string }).eventId);
    expect(ids[0]).toBe(ids[1]);
    expect(ids[1]).toBe(ids[2]);
    expect(ids[0]).not.toBe("delivery-1");
    expect(container.querySelector('[data-testid="dispatcher-next-event"]')).toBeNull();
    await act(async () => { root.unmount(); });
  });

  it("keeps the same eventId after unknown remount and does not auto-pick another source", async () => {
    const ingest = vi.fn()
      .mockRejectedValueOnce(new Error("rpc down"))
      .mockResolvedValueOnce({
        ok: true as const,
        value: {
          id: "iev_aaaaaaaa",
          sourceId: liveSource.id,
          projectId: "proj_7e4gc9rb6t",
          eventId: "kept",
          topic: "qa.root_observe",
          bodyDigest: "digest",
          state: "accepted" as const,
          duplicate: true,
          depth: 0,
        },
      });
    const api = {
      listActionIntents: vi.fn(async () => ({ ok: true as const, value: [] })),
      listEventDefinitions: vi.fn(async () => ({ ok: true as const, value: [] })),
      listEventSources: vi.fn(async () => ({
        ok: true as const,
        value: [liveSource, { id: "evs_bbbbbbbb", projectId: "proj_7e4gc9rb6t", kind: "webhook", enabled: true }],
      })),
      listRuleVersions: vi.fn(async () => ({ ok: true as const, value: [] })),
      ingestInboxEvent: ingest,
      saveEventDefinition: vi.fn(),
      saveEventSource: vi.fn(),
      saveRuleVersion: vi.fn(),
      dispatchTick: vi.fn(),
      claimActionIntent: vi.fn(),
      approveActionIntent: vi.fn(),
    } as unknown as DispatcherApi;
    const container = document.body.appendChild(document.createElement("div"));
    const root: Root = createRoot(container);
    const renderPage = () => root.render(createElement(DispatcherAutomationsPage, {
      api,
      projects: [liveBinding],
      projectId: "bnd_aaaaaaaa",
      departments: [],
      notice: () => undefined,
    }) as ReactNode);
    await act(async () => { renderPage(); });
    await act(async () => {
      pressTab(container.querySelector('[data-testid="dispatcher-tab-События"]'));
    });
    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="dispatcher-ingest"]')).toBeTruthy();
    });
    await act(async () => {
      container.querySelector('[data-testid="dispatcher-ingest"]')?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await vi.waitFor(() => expect(ingest).toHaveBeenCalledTimes(1));
    const firstId = (ingest.mock.calls[0]![0] as { eventId: string; sourceId: string }).eventId;
    const firstSource = (ingest.mock.calls[0]![0] as { sourceId: string }).sourceId;
    await act(async () => {
      pressTab(container.querySelector('[data-testid="dispatcher-tab-Согласование"]'));
    });
    await act(async () => {
      pressTab(container.querySelector('[data-testid="dispatcher-tab-События"]'));
    });
    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="dispatcher-ingest"]')).toBeTruthy();
    });
    await act(async () => {
      container.querySelector('[data-testid="dispatcher-ingest"]')?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await vi.waitFor(() => expect(ingest).toHaveBeenCalledTimes(2));
    expect((ingest.mock.calls[1]![0] as { eventId: string }).eventId).toBe(firstId);
    expect((ingest.mock.calls[1]![0] as { sourceId: string }).sourceId).toBe(firstSource);
    await act(async () => { root.unmount(); });
  });

  it("keeps ingest disabled after accepted remount until explicit next", async () => {
    const ingest = vi.fn(async (input: { eventId: string }) => ({
      ok: true as const,
      value: {
        id: "iev_aaaaaaaa",
        sourceId: liveSource.id,
        projectId: "proj_7e4gc9rb6t",
        eventId: input.eventId,
        topic: "qa.root_observe",
        bodyDigest: "digest",
        state: "accepted" as const,
        duplicate: false,
        depth: 0,
      },
    }));
    const api = {
      listActionIntents: vi.fn(async () => ({ ok: true as const, value: [] })),
      listEventDefinitions: vi.fn(async () => ({ ok: true as const, value: [] })),
      listEventSources: vi.fn(async () => ({ ok: true as const, value: [liveSource] })),
      listRuleVersions: vi.fn(async () => ({ ok: true as const, value: [] })),
      ingestInboxEvent: ingest,
      saveEventDefinition: vi.fn(),
      saveEventSource: vi.fn(),
      saveRuleVersion: vi.fn(),
      dispatchTick: vi.fn(),
      claimActionIntent: vi.fn(),
      approveActionIntent: vi.fn(),
    } as unknown as DispatcherApi;
    const container = document.body.appendChild(document.createElement("div"));
    const root: Root = createRoot(container);
    await act(async () => {
      root.render(createElement(DispatcherAutomationsPage, {
        api,
        projects: [liveBinding],
        projectId: "bnd_aaaaaaaa",
        departments: [],
        notice: () => undefined,
      }) as ReactNode);
    });
    await act(async () => {
      pressTab(container.querySelector('[data-testid="dispatcher-tab-События"]'));
    });
    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="dispatcher-ingest"]')).toBeTruthy();
    });
    await act(async () => {
      container.querySelector('[data-testid="dispatcher-ingest"]')?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="dispatcher-next-event"]')).toBeTruthy();
    });
    const firstId = (ingest.mock.calls[0]![0] as { eventId: string }).eventId;
    await act(async () => {
      pressTab(container.querySelector('[data-testid="dispatcher-tab-Согласование"]'));
    });
    await act(async () => {
      pressTab(container.querySelector('[data-testid="dispatcher-tab-События"]'));
    });
    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="dispatcher-next-event"]')).toBeTruthy();
    });
    expect(container.querySelector('[data-testid="dispatcher-ingest"]')).toHaveProperty("disabled", true);
    await act(async () => {
      container.querySelector('[data-testid="dispatcher-ingest"]')?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(ingest).toHaveBeenCalledTimes(1);
    await act(async () => {
      container.querySelector('[data-testid="dispatcher-next-event"]')?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await act(async () => {
      pressTab(container.querySelector('[data-testid="dispatcher-tab-Согласование"]'));
    });
    await act(async () => {
      pressTab(container.querySelector('[data-testid="dispatcher-tab-События"]'));
    });
    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="dispatcher-ingest"]')).toHaveProperty("disabled", false);
    });
    await act(async () => {
      container.querySelector('[data-testid="dispatcher-ingest"]')?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await vi.waitFor(() => expect(ingest).toHaveBeenCalledTimes(2));
    expect((ingest.mock.calls[1]![0] as { eventId: string }).eventId).not.toBe(firstId);
    await act(async () => { root.unmount(); });
  });

  it("fails closed when a restored source is missing from the catalog", async () => {
    writeIngestDraft(sessionStorage, "proj_7e4gc9rb6t", {
      schema: 1,
      eventId: "evt_restore-missing-source",
      sourceId: "evs_bbbbbbbb",
      topic: "qa.root_observe",
      reference: "qa:catalog-mapping-436",
      body: "{}",
      accepted: false,
    });
    const ingest = vi.fn();
    const api = {
      listActionIntents: vi.fn(async () => ({ ok: true as const, value: [] })),
      listEventDefinitions: vi.fn(async () => ({ ok: true as const, value: [] })),
      listEventSources: vi.fn(async () => ({ ok: true as const, value: [liveSource] })),
      listRuleVersions: vi.fn(async () => ({ ok: true as const, value: [] })),
      ingestInboxEvent: ingest,
      saveEventDefinition: vi.fn(),
      saveEventSource: vi.fn(),
      saveRuleVersion: vi.fn(),
      dispatchTick: vi.fn(),
      claimActionIntent: vi.fn(),
      approveActionIntent: vi.fn(),
    } as unknown as DispatcherApi;
    const container = document.body.appendChild(document.createElement("div"));
    const root: Root = createRoot(container);
    await act(async () => {
      root.render(createElement(DispatcherAutomationsPage, {
        api,
        projects: [liveBinding],
        projectId: "bnd_aaaaaaaa",
        departments: [],
        notice: () => undefined,
      }) as ReactNode);
    });
    await act(async () => {
      pressTab(container.querySelector('[data-testid="dispatcher-tab-События"]'));
    });
    await vi.waitFor(() => {
      expect(container.textContent).toContain(INGEST_SOURCE_GONE);
    });
    expect(container.querySelector('[data-testid="dispatcher-ingest"]')).toHaveProperty("disabled", true);
    expect(container.textContent).not.toContain("Уведомление · evs_204ecd8616520806d5329f07");
    await act(async () => { root.unmount(); });
  });

  it("keeps job decision inbox and does not open answer/resume", async () => {
    const opened: string[] = [];
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root: Root = createRoot(container);
    await act(async () => {
      root.render(createElement(InboxPage, {
        jobs: [job("AG-1607", "waiting_input"), job("AG-1606", "running")],
        agents: [],
        readIds: [],
        setReadIds: () => undefined,
        go: (_section, id) => { if (id) opened.push(id); },
        dispatcher: {
          listActionIntents: async () => ({ ok: true as const, value: [approval] }),
          approveActionIntent: async () => ({ ok: false as const, failure: { kind: "unavailable" as const, message: "hold" } }),
          claimActionIntent: async () => ({ ok: false as const, failure: { kind: "unavailable" as const, message: "hold" } }),
        },
      }) as ReactNode);
    });
    expect(container.querySelector('[data-testid="inbox-row-AG-1607"]')).toBeTruthy();
    expect(container.textContent).not.toMatch(/Отправить ответ|Повторить ту же команду|stdout|resume/i);
    await act(async () => { root.unmount(); });
  });
});
