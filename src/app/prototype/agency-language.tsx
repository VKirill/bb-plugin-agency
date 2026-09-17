import { useEffect, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../../shared/rpc-contract";
import { rememberUiLanguage, tr } from "../i18n";
import { HintedChoice, Panel } from "./shared";

type Language = "ru" | "en";

/** Fired after the Agency language is saved: the shell reloads it and redraws the interface. */
export const AGENCY_LANGUAGE_EVENT = "agency-language-changed";

const OPTIONS = [
  {
    value: "ru" as const,
    label: "Русский",
    description: "Сотрудники пишут отчёты, комментарии и вопросы на русском.",
    hint: ["Инструкции и служебные сообщения агентам всегда на английском: так их точнее понимают модели. Одна строка в них велит отвечать на русском."],
  },
  {
    value: "en" as const,
    label: "English",
    description: "Employees write reports, job comments and questions in English.",
    hint: ["Instructions and service messages to agents are always in English; one line in them sets the language of replies."],
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
      rememberUiLanguage(saved.language);
      notice(saved.language === "en" ? "Agency language: English. Employees reply in English from their next turn. The name in the BB sidebar changes after the page reloads." : "Язык Агентства: русский. Сотрудники отвечают по-русски со следующего хода. Название в боковой панели BB сменится после обновления страницы.");
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
        info={<><p>{tr("Язык, на котором сотрудники пишут отчёты, комментарии и вопросы владельцу, и язык интерфейса и комментариев Агентства. Инструкции агентам всегда на английском.")}</p><p>{tr("Действует на следующие ходы и запуски. Интерфейс Агентства переключается сразу.")}</p></>}
      />
    </Panel>
  );
}
