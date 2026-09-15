/** @vitest-environment happy-dom */
import { afterEach, describe, expect, it } from "vitest";
import { act, createElement, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JobEditDialog } from "../src/app/prototype/job-edit-dialog";

function Probe({ persist }: { persist: () => Promise<boolean> }) {
  const [open, setOpen] = useState(true);
  const [title, setTitle] = useState("AG-1608");
  const [description, setDescription] = useState("Старый brief\n\nКритерии приёмки:\nСтарые");
  const [pending, setPending] = useState(false);
  const save = async () => {
    setPending(true);
    const ok = await persist();
    setPending(false);
    if (!ok) return;
    setOpen(false);
  };
  return createElement(JobEditDialog, {
    open,
    title,
    description,
    pending,
    onOpenChange: setOpen,
    onTitle: setTitle,
    onDescription: setDescription,
    onSave: save,
  });
}

describe("JobEditDialog retain draft", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("keeps dialog and textarea after failed persist", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root: Root = createRoot(container);
    await act(async () => {
      root.render(createElement(Probe, { persist: async () => false }) as ReactNode);
    });
    const dialog = document.querySelector('[data-testid="job-edit-dialog"]');
    expect((dialog?.querySelector("textarea") as HTMLTextAreaElement | null)?.value).toContain("Старый brief");
    const save = document.querySelector('[data-testid="job-edit-save"]') as HTMLButtonElement;
    await act(async () => {
      save.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
    expect(document.querySelector('[data-testid="job-edit-dialog"]')).toBeTruthy();
    expect((document.querySelector('[data-testid="job-edit-dialog"] textarea') as HTMLTextAreaElement).value).toContain("Старый brief");
    await act(async () => { root.unmount(); });
  });
});
