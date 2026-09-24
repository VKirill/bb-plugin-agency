/** @vitest-environment happy-dom */
import { describe, expect, it, vi } from "vitest";
import { act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const plugins = [
  { id: "agency", name: "Агентство", description: null, version: "1", running: true, toolNames: [], hasSkill: true, cliCommand: "agency" },
  { id: "env-catalog", name: "Env Catalog", description: "Ключи", version: "1", running: true, toolNames: ["env_get", "env_set"], hasSkill: true, cliCommand: "env-catalog" },
  { id: "file-gateway", name: "File Gateway", description: null, version: "1", running: true, toolNames: ["bb_file_gateway"], hasSkill: true, cliCommand: "file-gateway" },
  { id: "provider-codex", name: "Codex", description: null, version: "1", running: true, toolNames: [], hasSkill: false, cliCommand: null },
  { id: "voice-input", name: "Voice", description: null, version: "1", running: false, toolNames: [], hasSkill: true, cliCommand: null },
  { id: "office-viewer", name: "Office Viewer", description: null, version: "1", running: true, toolNames: [], hasSkill: false, hasInstructions: false, cliCommand: null },
];
const rpc = { call: async (method: string) => (method === "listPlugins" ? { ok: true, value: { plugins, features: { projectFolders: true, fileGateway: true } } } : { ok: true, value: null }) };
vi.mock("@get-bb/plugin-sdk/app", () => ({ useRpc: () => rpc }));

const { AgentPluginsPanel, employeePluginCandidates } = await import("../src/app/prototype/agent-plugins");

describe("employee plugins tab", () => {
  it("offers running plugins with tools or skills, never the Agency or providers", () => {
    expect(employeePluginCandidates(plugins, []).map((plugin) => plugin.id)).toEqual(["env-catalog", "file-gateway"]);
    expect(employeePluginCandidates(plugins, ["voice-input"]).map((plugin) => plugin.id)).toContain("voice-input");
  });

  it("toggles a plugin and warns about secrets and missing plugins", async () => {
    const changes: string[][] = [];
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const render = async (selected: string[]) => {
      await act(async () => {
        root.render(createElement(AgentPluginsPanel, { selected, onChange: (ids: string[]) => changes.push(ids), notice: () => undefined }) as ReactNode);
      });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    };
    await render([]);
    expect(container.textContent).toContain("File Gateway");
    expect(container.querySelector('[data-testid="plugin-tags-file-gateway"]')?.textContent).toBe("навыкинструментыbb_file_gatewaybb file-gateway");
    expect(container.textContent).toContain("Навыки · 2");
    expect(container.textContent).toContain("Не показаны плагины, которые меняют только интерфейс BB");
    expect(container.textContent).not.toContain("Codex");
    const box = container.querySelector('[aria-label="File Gateway"]') as HTMLElement;
    await act(async () => box.click());
    expect(changes.at(-1)).toEqual(["file-gateway"]);

    await render(["env-catalog", "telegram-projects"]);
    expect(container.textContent).toContain("все ключи Env Catalog");
    expect(container.textContent).toContain("Плагин не установлен в BB");
    await act(async () => root.unmount());
  });
});

it("searches the bounded plugin list without dropping hidden selections", async()=>{
 const container=document.createElement("div");document.body.append(container);const root=createRoot(container);const changes:string[][]=[];
 try{
  await act(async()=>root.render(createElement(AgentPluginsPanel,{selected:["env-catalog"],onChange:ids=>changes.push(ids),notice:()=>{}})));
  const list=container.querySelector('[data-testid="agent-plugins"]')!;
  expect(list.classList.contains("max-h-80")).toBe(true);expect(list.classList.contains("overflow-y-auto")).toBe(true);
  const search=container.querySelector('[aria-label="Поиск плагинов"]') as HTMLInputElement;
  expect(list.contains(search)).toBe(false);
  await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(search,"bb_file_gateway");search.dispatchEvent(new Event("input",{bubbles:true}));});
  expect(list.querySelector('[aria-label="Env Catalog"]')).toBeNull();
  await act(async()=> (list.querySelector('[aria-label="File Gateway"]') as HTMLElement).click());
  expect(changes.at(-1)).toEqual(["env-catalog","file-gateway"]);
 }finally{await act(async()=>root.unmount());container.remove();}
});
