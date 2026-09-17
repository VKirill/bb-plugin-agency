/** @vitest-environment happy-dom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ModelPricesView } from "../src/shared/rpc-contract";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let saved: unknown = null;
let view: ModelPricesView = {
  rows: [
    { model: "claude-sonnet-5", input: 2, cachedInput: 0.2, output: 10, custom: false },
    { model: "grok-4.6", input: 3, cachedInput: 0.3, output: 15, custom: true },
  ],
  usedModels: ["grok-4.6", "gpt-5.6-luna"],
  checkedAt: "2026-09-16",
  source: "https://example.test/pricing",
  error: null,
};

const rpc = {
  call: async (method: string, input: unknown) => {
    if (method === "setModelPrices") {
      saved = input;
      const rows = (input as { rows: { model: string; input: number; cachedInput: number; output: number }[] }).rows;
      view = { ...view, rows: rows.map((row) => ({ ...row, custom: true })) };
    }
    return view;
  },
};

vi.mock("@get-bb/plugin-sdk/app", () => ({ useRpc: () => rpc }));

const { ModelPricesPanel } = await import("../src/app/prototype/model-prices");

let root: Root | null = null;
let host: HTMLElement | null = null;

async function mount() {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(createElement(ModelPricesPanel, { notice: () => undefined }));
  });
  return host;
}

afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  saved = null;
});

function typeInto(node: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(node, value);
  node.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("ModelPricesPanel", () => {
  it("shows the whole table with the models in use first", async () => {
    const container = await mount();
    const models = Array.from(container.querySelectorAll('input[aria-label="Модель"]')).map((node) => (node as HTMLInputElement).value);
    expect(models).toEqual(["grok-4.6", "claude-sonnet-5"]);
    expect(container.textContent).toContain("в работе");
    // A model employees run without a price is offered as one click.
    expect(Array.from(container.querySelectorAll("button")).some((node) => node.textContent === "+ gpt-5.6-luna")).toBe(true);
  });

  it("saves an edited price and a model added by hand", async () => {
    const container = await mount();
    const add = Array.from(container.querySelectorAll("button")).find((node) => node.textContent === "+ gpt-5.6-luna")!;
    await act(async () => { add.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    const output = container.querySelector('input[aria-label="Ответ · gpt-5.6-luna"]') as HTMLInputElement;
    await act(async () => { typeInto(output, "1,5"); });
    const save = Array.from(container.querySelectorAll("button")).find((node) => node.textContent === "Сохранить цены")!;
    expect(save.hasAttribute("disabled")).toBe(false);
    await act(async () => { save.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(saved).toEqual({
      rows: [
        { model: "grok-4.6", input: 3, cachedInput: 0.3, output: 15 },
        { model: "claude-sonnet-5", input: 2, cachedInput: 0.2, output: 10 },
        { model: "gpt-5.6-luna", input: 0, cachedInput: 0, output: 1.5 },
      ],
    });
  });

  it("holds the save back while a price is not a number", async () => {
    const container = await mount();
    const input = container.querySelector('input[aria-label="Вход · grok-4.6"]') as HTMLInputElement;
    await act(async () => { typeInto(input, "дорого"); });
    const save = Array.from(container.querySelectorAll("button")).find((node) => node.textContent === "Сохранить цены")!;
    expect(save.hasAttribute("disabled")).toBe(true);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Цена должна быть числом от 0.");
  });
});
