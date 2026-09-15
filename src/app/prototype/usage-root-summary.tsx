import { useCallback, useEffect, useRef, useState } from "react";
import type { AgencyApi } from "../data/agency-api";
import { allTimeHeadline, createUsageFetchGate, parseDashboardUsage } from "../data/usage-dashboard";
import { Button } from "./shared";
import { useUsageRealtime } from "./usage-realtime";

export function UsageRootSummary({
  api,
  rootJobId,
  revision,
  openUsage,
}: {
  api: AgencyApi;
  rootJobId: string;
  revision?: number;
  openUsage: () => void;
}) {
  const [label, setLabel] = useState<string | null>(null);
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
      setLabel(parsed ? allTimeHeadline(parsed) : null);
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

  if (!label) return null;
  return (
    <section aria-label="Расход главной задачи" className="mt-3 flex flex-wrap items-center justify-between gap-2 text-sm" data-testid="usage-root-summary">
      <p><span className="text-xs text-muted-foreground">Расход · </span>{label}</p>
      <Button size="sm" variant="ghost" onClick={openUsage}>Открыть дашборд</Button>
    </section>
  );
}
