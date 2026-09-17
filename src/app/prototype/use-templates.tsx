import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { AgencyApi } from "../data/agency-api";
import { defaultTemplates, type TemplateKey } from "../../shared/templates";
import { uiLanguage } from "../i18n";

type TemplatesState = { templates: Record<TemplateKey, string>; reload: () => void };

const TemplatesContext = createContext<TemplatesState | null>(null);

/**
 * Loads the owner's form templates («Настройки → Шаблоны») once for the whole
 * Agency view. Forms read them from context; without a provider (demo, tests)
 * the standard texts apply.
 */
export function TemplatesProvider({ api, enabled, children }: { api: Pick<AgencyApi, "listTemplates">; enabled: boolean; children: ReactNode }) {
  const [templates, setTemplates] = useState<Record<TemplateKey, string>>(() => defaultTemplates(uiLanguage()));
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    void api.listTemplates().then(
      (result) => {
        if (live && result.ok) setTemplates({ ...defaultTemplates(uiLanguage()), ...Object.fromEntries(result.value.map((row) => [row.key, row.text])) });
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [api, enabled, tick]);
  const reload = useCallback(() => setTick((value) => value + 1), []);
  const value = useMemo(() => ({ templates, reload }), [templates, reload]);
  return <TemplatesContext.Provider value={value}>{children}</TemplatesContext.Provider>;
}

export function useTemplates(): Record<TemplateKey, string> {
  return useContext(TemplatesContext)?.templates ?? defaultTemplates(uiLanguage());
}

export function useReloadTemplates(): () => void {
  return useContext(TemplatesContext)?.reload ?? noop;
}

const noop = () => undefined;
