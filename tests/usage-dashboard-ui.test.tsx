/** @vitest-environment happy-dom */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseDashboardUsage } from "../src/app/data/usage-dashboard";
import { UsageDashboard } from "../src/app/prototype/usage-dashboard";

const livePath = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../.bb/chats/thr_2sgqe4rmmd/artifacts/programmers-calculator/dashboard-live-582.json",
);

describe("UsageDashboard", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("renders live 582 headline, coverage, separate cache, and no demo zeros", async () => {
    const payload = parseDashboardUsage(JSON.parse(readFileSync(livePath, "utf8")));
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root: Root = createRoot(container);
    await act(async () => {
      root.render(createElement(UsageDashboard, {
        payload,
        groupBy: "root",
      }) as ReactNode);
    });
    expect(container.querySelector("h1")?.textContent).toBe("Дашборд");
    expect(container.querySelector('[data-testid="usage-all-time"]')?.textContent).toBe("Не менее 24,9 млн");
    expect(container.textContent).toContain("Всего по доступным данным");
    expect(container.textContent).toContain("За выбранный период");
    expect(container.textContent).toContain("Входные без кэша");
    expect(container.textContent).toContain("24 786 713");
    expect(container.textContent).toContain("2 549 105");
    expect(container.querySelector('[data-testid="usage-day-chart"]')).toBeTruthy();
    expect(container.querySelector('input[type="date"][aria-label="Дата с"]')).toBeTruthy();
    expect(container.textContent).toContain("Главная задача");
    expect(container.textContent).toContain("5 задач");
    expect(container.textContent).toContain("1 неизвестно");
    expect(container.textContent).toContain("Нет цены");
    expect(container.querySelector("details")?.textContent).toContain("visible_epoch_peaks");
    expect(container.textContent).not.toContain("All-time");
    expect(container.textContent).not.toMatch(/Не lifetime|Видимые пики|Все корни|input /);
    expect(container.textContent).not.toContain("3/4");
    await act(async () => { root.unmount(); });
  });

  it("opens the root workspace key, not the first attempt job", async () => {
    const payload = parseDashboardUsage(JSON.parse(readFileSync(livePath, "utf8")));
    const opened: string[] = [];
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root: Root = createRoot(container);
    await act(async () => {
      root.render(createElement(UsageDashboard, {
        payload,
        groupBy: "root",
        names: {
          jobs: {
            job_48f521b219595a2042d992da: { key: "AG-2201", title: "Калькулятор" },
            job_d938992e8b309764551e9c99: { key: "AG-2202", title: "Ребёнок" },
          },
        },
        onOpenJob: (jobKey) => {
          opened.push(jobKey);
        },
      }) as ReactNode);
    });
    const button = Array.from(container.querySelectorAll("button")).find((node) => node.textContent === "Калькулятор");
    expect(button).toBeTruthy();
    await act(async () => {
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(opened).toEqual(["AG-2201"]);
    await act(async () => { root.unmount(); });
  });
});
