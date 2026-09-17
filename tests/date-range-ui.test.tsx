/** @vitest-environment happy-dom */
import { afterEach, describe, expect, it } from "vitest";
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { DateRangePicker } from "../src/app/prototype/date-range";
import type { DateRange } from "../src/app/data/date-range";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;
const seen: DateRange[] = [];

function Harness() {
  const [range, setRange] = useState<DateRange>({ fromDate: "2026-09-10", toDate: "2026-09-17" });
  return createElement(DateRangePicker, {
    range,
    onChange: (next: DateRange) => {
      seen.push(next);
      setRange(next);
    },
  });
}

afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  seen.length = 0;
});

async function mount() {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(createElement(Harness)); });
  return host;
}

function click(node: Element | null | undefined) {
  node?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

describe("DateRangePicker", () => {
  it("shows the chosen range and takes both ends from one calendar", async () => {
    const container = await mount();
    const trigger = container.querySelector('[data-testid="usage-range-trigger"]')!;
    expect(trigger.textContent).toContain("—");
    await act(async () => { click(trigger); });

    const day = (iso: string) => document.querySelector(`button[aria-label="${iso}"]`);
    expect(day("2026-09-17")).toBeTruthy();
    // A third click starts a new range: first the start…
    await act(async () => { click(day("2026-09-02")); });
    expect(seen.at(-1)).toEqual({ fromDate: "2026-09-02", toDate: "" });
    // …then the end, and the calendar closes because nothing is left to say.
    await act(async () => { click(day("2026-09-08")); });
    expect(seen.at(-1)).toEqual({ fromDate: "2026-09-02", toDate: "2026-09-08" });
    expect(container.querySelector('[data-testid="usage-range-trigger"]')?.textContent).toContain("02 сент.");
  });

  it("offers the usual windows and a way back to everything", async () => {
    const container = await mount();
    await act(async () => { click(container.querySelector('[data-testid="usage-range-trigger"]')); });
    const whole = Array.from(document.querySelectorAll("button")).find((node) => node.textContent === "Весь период");
    await act(async () => { click(whole); });
    expect(seen.at(-1)).toEqual({ fromDate: "", toDate: "" });
    expect(container.querySelector('[data-testid="usage-range-trigger"]')?.textContent).toContain("Весь период");
  });
});
