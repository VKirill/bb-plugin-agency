import { useMemo, useState } from "react";
import type { PluginPendingInteractionProps } from "@get-bb/plugin-sdk/app";
import {
  ownerQuestionPayloadSchema,
  ownerQuestionResponseSchema,
} from "../../shared/contracts/owner-question";
import { Button, Textarea } from "./shared";
import { tr } from "../i18n";

const OTHER = "__other__";

export function OwnerQuestionInteraction({
  interaction,
  submit,
  cancel,
}: PluginPendingInteractionProps) {
  const parsed = useMemo(
    () => ownerQuestionPayloadSchema.safeParse(interaction.payload),
    [interaction.payload],
  );
  const [busy, setBusy] = useState(false);
  const [picked, setPicked] = useState<Record<string, string>>({});
  const [other, setOther] = useState<Record<string, string>>({});

  if (!parsed.success) {
    return (
      <div className="flex flex-col gap-3">
        <p className="text-sm text-muted-foreground">{tr("Карточка вопроса повреждена.")}</p>
        <Button type="button" variant="outline" onClick={() => void cancel().catch(() => undefined)}>
          {tr("Отмена")}
        </Button>
      </div>
    );
  }

  const keys = [...new Set(parsed.data.jobs.map((job) => job.key))];
  const ready = parsed.data.items.every((item) => {
    const value = picked[item.id];
    if (!value) return false;
    if (value === OTHER) return Boolean(other[item.id]?.trim());
    return true;
  });

  const answers = (): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const item of parsed.data.items) {
      const value = picked[item.id];
      if (value === OTHER) {
        out[item.id] = other[item.id]?.trim() ?? "";
        continue;
      }
      const option = item.options.find((entry) => entry.id === value);
      out[item.id] = option
        ? option.description
          ? `${option.label}. ${option.description}`
          : option.label
        : value ?? "";
    }
    return out;
  };

  return (
    <div className="flex flex-col gap-4">
      <div>
        <div className="text-sm font-medium">{tr("Агентство ждёт ответ")}</div>
        {keys.length ? (
          <p className="mt-1 text-xs text-muted-foreground">{keys.join(" · ")}</p>
        ) : null}
        <p className="mt-1 text-xs text-muted-foreground">
          {tr("Одинаковые вопросы в нескольких задачах получат один ответ. Нажмите вариант и Send.")}
        </p>
      </div>
      {parsed.data.items.map((item) => {
        const selected = picked[item.id];
        const hasOptions = item.options.length >= 2;
        return (
          <div key={item.id} className="flex flex-col gap-2">
            <div className="text-xs font-medium text-muted-foreground">{item.header}</div>
            <p className="text-sm">{item.text}</p>
            {hasOptions ? (
              <div className="flex flex-col gap-1.5">
                {item.options.map((option) => {
                  const active = selected === option.id;
                  return (
                    <Button
                      key={option.id}
                      type="button"
                      variant={active ? "default" : "outline"}
                      disabled={busy}
                      className="h-auto justify-start whitespace-normal px-3 py-2 text-left text-sm"
                      aria-pressed={active}
                      onClick={() => setPicked((current) => ({ ...current, [item.id]: option.id }))}
                    >
                      <span className="font-medium">{option.label}</span>
                      {option.description ? (
                        <span className={active ? "font-normal opacity-90" : "font-normal text-muted-foreground"}>
                          {` — ${option.description}`}
                        </span>
                      ) : null}
                    </Button>
                  );
                })}
                <Button
                  type="button"
                  variant={selected === OTHER ? "default" : "outline"}
                  disabled={busy}
                  className="h-auto justify-start px-3 py-2 text-sm"
                  aria-pressed={selected === OTHER}
                  onClick={() => setPicked((current) => ({ ...current, [item.id]: OTHER }))}
                >
                  {tr("Другое")}
                </Button>
                {selected === OTHER ? (
                  <Textarea
                    value={other[item.id] ?? ""}
                    disabled={busy}
                    rows={3}
                    placeholder={tr("Свой ответ")}
                    onChange={(event) =>
                      setOther((current) => ({ ...current, [item.id]: event.target.value }))
                    }
                  />
                ) : null}
              </div>
            ) : (
              <Textarea
                value={other[item.id] ?? ""}
                disabled={busy}
                rows={4}
                placeholder={tr("Свой ответ")}
                onChange={(event) => {
                  const text = event.target.value;
                  setOther((current) => ({ ...current, [item.id]: text }));
                  setPicked((current) => ({ ...current, [item.id]: text.trim() ? OTHER : "" }));
                }}
              />
            )}
          </div>
        );
      })}
      <div className="flex gap-2">
        <Button
          type="button"
          disabled={busy || !ready}
          onClick={() => {
            const body = ownerQuestionResponseSchema.safeParse({ answers: answers() });
            if (!body.success) return;
            setBusy(true);
            void submit(body.data)
              .catch(() => undefined)
              .finally(() => setBusy(false));
          }}
        >
          {tr("Отправить")}
        </Button>
        <Button type="button" variant="outline" disabled={busy} onClick={() => void cancel().catch(() => undefined)}>
          {tr("Отмена")}
        </Button>
      </div>
    </div>
  );
}
