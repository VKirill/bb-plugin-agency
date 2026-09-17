import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgencyApi } from "../data/agency-api";
import type { Job } from "./data";
import { STAGE1_UNAVAILABLE } from "../data/runtime-unavailable";
import {
  EMPTY_USAGE_FILTER,
  USAGE_DEMO,
  USAGE_LOAD_FAILED,
  catalogNamesFromWorkspace,
  createUsageFetchGate,
  dashboardQueryFromFilter,
  parseDashboardUsage,
  type UsageFilter,
  type UsageGroupBy,
} from "../data/usage-dashboard";
import type { ListDashboardUsageOutput } from "../../shared/contracts/dashboard-usage";
import type { BudgetStatusView, ProviderUsageView } from "../../shared/rpc-contract";
import { Empty } from "./shared";
import { tr } from "../i18n";
import { UsageDashboard } from "./usage-dashboard";
import { useUsageRealtime } from "./usage-realtime";

export function UsagePage({
  api,
  jobs,
  projects,
  departments,
  rootJobId,
  demoMode = false,
  openJob,
}: {
  api: AgencyApi;
  jobs: Job[];
  projects: { id: string; name: string; bbProjectId?: string }[];
  departments: { id: string; name: string }[];
  rootJobId?: string;
  demoMode?: boolean;
  openJob: (id: string) => void;
}) {
  const names = useMemo(
    () => catalogNamesFromWorkspace({ jobs, projects, departments }),
    [jobs, projects, departments],
  );
  const [groupBy, setGroupBy] = useState<UsageGroupBy>("root");
  const [filter, setFilter] = useState<UsageFilter>({ ...EMPTY_USAGE_FILTER, rootJobId: rootJobId || "" });
  const [payload, setPayload] = useState<ListDashboardUsageOutput | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(!demoMode);
  const [budgets, setBudgets] = useState<BudgetStatusView[]>([]);
  const [providers, setProviders] = useState<ProviderUsageView[]>([]);
  const gate = useRef(createUsageFetchGate());

  useEffect(() => {
    const current = gate.current;
    current.mount();
    return () => {
      current.unmount();
    };
  }, []);

  useEffect(() => {
    setFilter((current) => (current.rootJobId === (rootJobId || "") ? current : { ...current, rootJobId: rootJobId || "" }));
  }, [rootJobId]);

  const refresh = useCallback(async () => {
    if (demoMode) {
      setPayload(null);
      setError(null);
      setLoading(false);
      return;
    }
    if (!gate.current.isMounted()) return;
    const token = gate.current.begin();
    setLoading(true);
    try {
      const [result, budgetList, providerList] = await Promise.all([
        api.listDashboardUsage(dashboardQueryFromFilter(filter)),
        api.listBudgets ? api.listBudgets().catch(() => null) : Promise.resolve(null),
        api.providerUsage ? api.providerUsage().catch(() => null) : Promise.resolve(null),
      ]);
      if (!gate.current.accept(token)) return;
      setBudgets(budgetList?.ok ? budgetList.value : []);
      setProviders(providerList?.ok ? providerList.value : []);
      if (!result.ok) {
        setPayload(null);
        setError(result.failure.kind === "unavailable" ? tr(STAGE1_UNAVAILABLE.usage) : tr(USAGE_LOAD_FAILED));
        return;
      }
      const parsed = parseDashboardUsage(result.value);
      setPayload(parsed);
      setError(parsed ? null : tr(USAGE_LOAD_FAILED));
    } catch {
      if (!gate.current.accept(token)) return;
      setPayload(null);
      setError(tr(USAGE_LOAD_FAILED));
    } finally {
      if (gate.current.accept(token)) setLoading(false);
    }
  }, [api, demoMode, filter]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useUsageRealtime(() => {
    void refresh();
  });

  if (demoMode) {
    return <Empty title="Дашборд" description={USAGE_DEMO} />;
  }

  return (
    <UsageDashboard
      payload={payload}
      names={names}
      groupBy={groupBy}
      filter={filter}
      error={error}
      loading={loading}
      onGroupBy={setGroupBy}
      onFilter={setFilter}
      onOpenJob={openJob}
      budgets={budgets}
      providers={providers}
    />
  );
}
