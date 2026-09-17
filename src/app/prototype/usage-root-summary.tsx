import { useCallback, useEffect, useRef, useState } from "react";
import type { AgencyApi } from "../data/agency-api";
import { allTimeHeadline, createUsageFetchGate, formatCostUsd, parseDashboardUsage } from "../data/usage-dashboard";
import { Button } from "./shared";
import { tr } from "../i18n";
import { RailRow } from "./job-rail";
import { useUsageRealtime } from "./usage-realtime";

export function UsageRootSummary({
  api,
  rootJobId,
  revision,
  openUsage,
  variant = "inline",
}: {
  api: AgencyApi;
  rootJobId: string;
  revision?: number;
  openUsage: () => void;
  /** rail — label → value rows inside a task rail card. */
  variant?: "inline" | "rail";
}) {
  const [label, setLabel] = useState<string | null>(null);
  const [rail, setRail] = useState<{ tokens: string; cost: string | null } | null>(null);
  const gate = useRef(createUsageFetchGate());

  useEffect(() => {
    const current = gate.current;
    current.mount();
    return () => {
      current.unmount();
    };
  }, []);

  const refresh = useCallback(async () => {
    if (!gate.current.isMounted()) return;
    const token = gate.current.begin();
    try {
      const result = await api.listDashboardUsage({ rootJobId });
      if (!gate.current.accept(token)) return;
      if (!result.ok) {
        setLabel(null);
        return;
      }
      const parsed = parseDashboardUsage(result.value);
      const cost = parsed ? formatCostUsd(parsed.costUsdCents) : null;
      const tokensLabel = parsed ? tr("{headline} токенов", { headline: allTimeHeadline(parsed) }) : null;
      setLabel(tokensLabel ? `${tokensLabel}${cost ? ` · ${cost}` : ""}` : null);
      setRail(parsed ? { tokens: allTimeHeadline(parsed).replace(/^Не менее /, "≥ "), cost } : null);
    } catch {
      if (!gate.current.accept(token)) return;
      setLabel(null);
    }
  }, [api, rootJobId]);

  useEffect(() => {
    void refresh();
  }, [refresh, revision]);

  useUsageRealtime(() => {
    void refresh();
  });

  if (variant === "rail") {
    if (!rail) return <p className="agency-rail-empty">{tr("Расхода пока нет.")}</p>;
    return (
      <div data-testid="usage-root-summary">
        <RailRow label={tr("Токены")} value={rail.tokens} />
        <RailRow label={tr("Стоимость")} value={rail.cost ?? tr("нет цены")} tone={rail.cost ? "default" : "muted"} />
        <Button size="sm" variant="ghost" className="mt-1 h-auto px-0 text-xs" onClick={openUsage}>{tr("Открыть дашборд")}</Button>
      </div>
    );
  }
  if (!label) return null;
  return (
    <section aria-label={tr("Расход главной задачи")} className="mt-3 flex flex-wrap items-center justify-between gap-2 text-sm" data-testid="usage-root-summary">
      <p><span className="text-xs text-muted-foreground">{tr("Расход · ")}</span>{label}</p>
      <Button size="sm" variant="ghost" onClick={openUsage}>{tr("Открыть дашборд")}</Button>
    </section>
  );
}
