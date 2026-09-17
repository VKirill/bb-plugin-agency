import { useEffect, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../../shared/rpc-contract";
import { tr } from "../i18n";
import { HintedChoice, Panel } from "./shared";

type Language = "ru" | "en";

/** Fired after the Agency language is saved: the shell reloads it and redraws the interface. */
export const AGENCY_LANGUAGE_EVENT = "agency-language-changed";

const OPTIONS = [
  {
    value: "ru" as const,
    label: "Русский",
    description: "Сотрудники пишут отчёты, комментарии и вопросы на русском.",
    hint: ["Системные сообщения агентам — напоминания, предупреждения о зависании, возврат на доработку — тоже на русском."],
  },
  {
    value: "en" as const,
    label: "English",
    description: "Employees write reports, job comments and questions in English.",
    hint: ["System messages to agents — reminders, stall warnings, rework requests — are in English too."],
  },
];

/** Agency language: saved in the plugin settings, applied to the next agent turns and system messages. */
export function AgencyLanguagePanel({ notice }: { notice: (text: string) => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const [language, setLanguage] = useState<Language | null>(null);
  const [pending, setPending] = useState(false);
  useEffect(() => {
    let live = true;
    void Promise.resolve(rpc.call("agencyLanguage", null)).then(
      (value) => { if (live) setLanguage((value as { language: Language }).language); },
      () => { if (live) setLanguage("ru"); },
    );
    return () => { live = false; };
  }, [rpc]);
  const change = async (next: Language) => {
    if (pending || next === language) return;
    setPending(true);
    try {
      const saved = (await rpc.call("setAgencyLanguage", { language: next })) as { language: Language };
      setLanguage(saved.language);
      window.dispatchEvent(new Event(AGENCY_LANGUAGE_EVENT));
      notice(saved.language === "en" ? "Agency language: English. New agent turns and system messages will use it." : "Язык Агентства: русский. Новые ходы сотрудников и системные сообщения будут на русском.");
    } catch {
      notice(tr("Не удалось сохранить язык. Попробуйте ещё раз."));
    } finally {
      setPending(false);
    }
  };
  return (
    <Panel title="Язык · Language">
      <HintedChoice
        label="Язык Агентства"
        value={language ?? "ru"}
        onChange={(next) => void change(next)}
        options={OPTIONS}
        disabled={language === null || pending}
        info={<><p>{tr("Язык, на котором сотрудники пишут отчёты, комментарии и вопросы владельцу, и язык системных сообщений, которые Агентство отправляет агентам.")}</p><p>{tr("Действует на следующие ходы и запуски. Интерфейс Агентства переключается сразу.")}</p></>}
      />
    </Panel>
  );
}
