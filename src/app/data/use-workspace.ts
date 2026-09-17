import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRealtime, useRealtimeConnectionState } from "@get-bb/plugin-sdk/app";
import { tr } from "../i18n";
import type { Agent, Group, Job } from "../prototype/data";
import type { AgencyApi } from "./agency-api";
import type { RevisionConflict } from "../../shared/contracts";
import type { MutationOutcome } from "./envelope";
import { createRpcAgencyApi, type RpcCaller } from "./rpc-agency-api";
import { EMPTY_SNAPSHOT, type WorkspaceSnapshot } from "./snapshot";
import { dueAtFromDate, mapAgents, mapDepartments, mapJobs, mapProjects, parseDescription, PRIORITY_CODE, queueCounts, splitDescription } from "./view-models";
import { BRIEF_REQUIRED_NOTICE, canCreateJob, failureNotice, newRequestId, persistAgentPatch, persistDepartmentPatch, persistJobPatch, persistProjectAnyCli, persistProjectPatch } from "./persist";
import { persistCreateAgent, persistCreateBinding, persistCreateDepartment, type CreateAgentInput, type CreateBindingInput, type CreateDepartmentInput } from "./persist-create";
import { EMPTY_BB_CATALOG } from "./capability-catalog";
import type { BbCatalog } from "./store-commands";

export type WorkspaceStatus = "loading" | "ready" | "unavailable" | "gated" | "error";

export const WORKSPACE_REALTIME_POLL_MS = 8_000;

export function useAgencyWorkspace(rpc: RpcCaller, api?: AgencyApi) {
  const resolvedApi = useMemo(() => api ?? createRpcAgencyApi(rpc), [api, rpc]);
  const [status, setStatus] = useState<WorkspaceStatus>("loading");
  const [message, setMessage] = useState("");
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot>(EMPTY_SNAPSHOT);
  const [conflict, setConflict] = useState<RevisionConflict | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [departments, setDepartments] = useState<Group[]>([]);
  const [projects, setProjects] = useState<Group[]>([]);
  const [catalog, setCatalog] = useState<BbCatalog>(EMPTY_BB_CATALOG);
  const [catalogError, setCatalogError] = useState("");

  const applySnapshot = useCallback((next: WorkspaceSnapshot) => {
    setSnapshot(next);
    setJobs(mapJobs(next));
    setAgents(mapAgents(next));
    setDepartments(mapDepartments(next));
    setProjects(mapProjects(next));
    setConflict(null);
  }, []);

  const reloadGeneration = useRef(0);
  const hadReadySnapshot = useRef(false);
  const apiEpoch = useRef(resolvedApi);
  const runLoadRef = useRef<(opts?: { keepMessage?: boolean; refreshCatalog?: boolean }) => Promise<void>>(async () => undefined);
  const request = useRef({
    isMounted: true,
    isRunning: false,
    refreshQueued: false,
    keepMessage: false,
    refreshCatalog: true,
    waiters: [] as Array<() => void>,
  });

  if (apiEpoch.current !== resolvedApi) {
    apiEpoch.current = resolvedApi;
    reloadGeneration.current += 1;
  }

  const runLoad = useCallback(async (opts?: { keepMessage?: boolean; refreshCatalog?: boolean }) => {
    const token = ++reloadGeneration.current;
    if (!hadReadySnapshot.current) setStatus("loading");
    const result = await resolvedApi.loadWorkspace({});
    if (!request.current.isMounted || token !== reloadGeneration.current) return;
    if (result.status === "ready") {
      applySnapshot(result.snapshot);
      hadReadySnapshot.current = true;
      // The page is usable as soon as the snapshot lands; the BB catalog refreshes behind it.
      setStatus("ready");
      if (opts?.refreshCatalog) {
        const listed = await resolvedApi.listBbCatalog();
        if (!request.current.isMounted || token !== reloadGeneration.current) return;
        if (listed.ok) {
          setCatalog(listed.value);
          setCatalogError("");
        } else {
          setCatalogError(failureNotice(listed.failure));
        }
      }
      setStatus("ready");
      if (!opts?.keepMessage) setMessage("");
      return;
    }
    if (hadReadySnapshot.current) {
      setStatus("ready");
      setMessage(result.message || tr("Не удалось обновить снимок. Предыдущие данные оставлены."));
      return;
    }
    applySnapshot(EMPTY_SNAPSHOT);
    setCatalog(EMPTY_BB_CATALOG);
    setCatalogError("");
    setStatus(result.status);
    setMessage(result.message);
  }, [applySnapshot, resolvedApi]);
  runLoadRef.current = runLoad;

  const pump = useCallback(() => {
    const req = request.current;
    if (req.isRunning) return;
    req.isRunning = true;
    void (async () => {
      try {
        while (req.isMounted && req.refreshQueued) {
          req.refreshQueued = false;
          const keepMessage = req.keepMessage;
          const refreshCatalog = req.refreshCatalog;
          req.keepMessage = true;
          req.refreshCatalog = false;
          try {
            await runLoadRef.current({ keepMessage, refreshCatalog });
          } catch {
            if (hadReadySnapshot.current) setStatus("ready");
            else {
              setStatus("error");
              setMessage((current) => current || tr("Не удалось обновить снимок."));
            }
          }
        }
      } finally {
        req.isRunning = false;
        if (req.isMounted && req.refreshQueued) {
          pump();
          return;
        }
        const waiters = req.waiters.splice(0);
        for (const waiter of waiters) waiter();
      }
    })();
  }, []);

  const reload = useCallback((opts?: { keepMessage?: boolean; refreshCatalog?: boolean }) => {
    const req = request.current;
    if (!req.isMounted) return Promise.resolve();
    const keepMessage = Boolean(opts?.keepMessage);
    const refreshCatalog = opts?.refreshCatalog ?? !keepMessage;
    if (req.refreshQueued) {
      req.keepMessage = req.keepMessage && keepMessage;
      req.refreshCatalog = req.refreshCatalog || refreshCatalog;
    } else {
      req.keepMessage = keepMessage;
      req.refreshCatalog = refreshCatalog;
    }
    req.refreshQueued = true;
    const done = new Promise<void>((resolve) => {
      req.waiters.push(resolve);
    });
    pump();
    return done;
  }, [pump]);

  useEffect(() => {
    const req = request.current;
    req.isMounted = true;
    return () => {
      req.isMounted = false;
      req.refreshQueued = false;
      const waiters = req.waiters.splice(0);
      for (const waiter of waiters) waiter();
    };
  }, []);

  useEffect(() => {
    void reload();
  }, [resolvedApi, reload]);

  const connectionState = useRealtimeConnectionState();
  const previousConnection = useRef(connectionState);
  useEffect(() => {
    const previous = previousConnection.current;
    previousConnection.current = connectionState;
    if (connectionState === "connected" && previous !== "connected") {
      void reload({ keepMessage: true });
    }
  }, [connectionState, reload]);

  useRealtime("domain-changed", () => {
    void reload({ keepMessage: true });
  });

  useEffect(() => {
    const timer = setInterval(() => {
      void reload({ keepMessage: true });
    }, WORKSPACE_REALTIME_POLL_MS);
    return () => clearInterval(timer);
  }, [reload]);

  const refreshCatalog = useCallback(async () => {
    const listed = await resolvedApi.listBbCatalog();
    if (!listed.ok) {
      setCatalogError(failureNotice(listed.failure));
      return false;
    }
    setCatalog(listed.value);
    setCatalogError("");
    return true;
  }, [resolvedApi]);

  const persistable = status === "ready" || hadReadySnapshot.current;

  const updateJob = useCallback(async (next: Job): Promise<boolean> => {
    const current = jobs.find((job) => job.id === next.id);
    if (!current) return false;
    if (!persistable) {
      setMessage(tr("Запись недоступна: сервер не отдал рабочий снимок."));
      return false;
    }
    const result = await persistJobPatch(resolvedApi, snapshot, current, next);
    if (!result.ok) {
      if (result.failure.kind === "revision_conflict") setConflict(result.failure.conflict);
      setMessage(failureNotice(result.failure));
      return false;
    }
    await reload();
    return true;
  }, [jobs, persistable, reload, resolvedApi, snapshot]);

  const addJob = useCallback(async (job: Job): Promise<boolean> => {
    if (!persistable) {
      setJobs((current) => [...current, job]);
      return true;
    }
    const target = canCreateJob(snapshot, { bindingId: job.bindingId, departmentId: job.departmentId });
    if (!target) {
      setMessage(tr("Укажите проект и отдел этой задачи. Первый проект или папка чата не подставляются."));
      return false;
    }
    const written = splitDescription(job.description);
    if (!written.brief.trim() || !written.acceptance?.trim()) {
      setMessage(tr(BRIEF_REQUIRED_NOTICE));
      return false;
    }
    const parsed = parseDescription(job.description);
    const assignee = snapshot.agents.find((agent) => agent.id === job.assignedAgentId) ?? snapshot.agents.find((agent) => agent.name === job.agent);
    // The server assigns the key: a key counted in the browser can collide with a job created elsewhere.
    const result = await resolvedApi.createJob({
      requestId: newRequestId(),
      bindingId: target.bindingId,
      departmentId: target.departmentId,
      title: job.title,
      brief: parsed.brief,
      acceptance: parsed.acceptance,
      parentJobId: job.parentId ? snapshot.jobs.find((item) => item.key === job.parentId)?.id ?? null : null,
      assignedAgentId: job.assignment ? null : assignee?.id ?? null,
      ...(job.assignment ? { assignment: job.assignment } : {}),
      priority: PRIORITY_CODE[job.priority as keyof typeof PRIORITY_CODE] ?? "normal",
      dueAt: dueAtFromDate(job.due),
      ...(job.contract ? { contract: job.contract } : {}),
    });
    if (!result.ok) {
      setMessage(failureNotice(result.failure));
      return false;
    }
    await reload();
    return true;
  }, [persistable, reload, resolvedApi, snapshot]);

  const updateAgent = useCallback((next: Agent) => {
    setAgents((current) => current.map((agent) => (agent.id === next.id ? next : agent)));
  }, []);

  const updateDepartment = useCallback((next: Group) => {
    setDepartments((current) => current.map((item) => (item.id === next.id ? next : item)));
  }, []);

  const commitAgent = useCallback(async (next: Agent) => {
    const current = agents.find((agent) => agent.id === next.id);
    if (!current || !persistable) return false;
    const result = await persistAgentPatch(resolvedApi, snapshot, current, next);
    if (!result.ok) {
      if (result.failure.kind === "revision_conflict") setConflict(result.failure.conflict);
      setMessage(failureNotice(result.failure));
      return false;
    }
    await reload();
    return true;
  }, [agents, persistable, reload, resolvedApi, snapshot]);

  const commitProject = useCallback(async (next: Group) => {
    const current = projects.find((item) => item.id === next.id);
    if (!current || !persistable) return false;
    const result = await persistProjectPatch(resolvedApi, snapshot, current, next);
    if (!result.ok) {
      if (result.failure.kind === "revision_conflict") setConflict(result.failure.conflict);
      setMessage(failureNotice(result.failure));
      return false;
    }
    await reload();
    return true;
  }, [persistable, projects, reload, resolvedApi, snapshot]);

  const commitDepartment = useCallback(async (next: Group) => {
    const current = departments.find((item) => item.id === next.id);
    if (!current || !persistable) return false;
    const result = await persistDepartmentPatch(resolvedApi, snapshot, current, next);
    if (!result.ok) {
      if (result.failure.kind === "revision_conflict") setConflict(result.failure.conflict);
      setMessage(failureNotice(result.failure));
      return false;
    }
    await reload();
    return true;
  }, [departments, persistable, reload, resolvedApi, snapshot]);

  const addProject = useCallback(async (input: CreateBindingInput): Promise<boolean> => {
    if (!persistable) return false;
    const result = await persistCreateBinding(resolvedApi, input, snapshot.policies);
    if (!result.ok) {
      setMessage(failureNotice(result.failure));
      return false;
    }
    await reload();
    return true;
  }, [persistable, reload, resolvedApi, snapshot.policies]);

  const addAgent = useCallback(async (input: CreateAgentInput): Promise<boolean> => {
    if (!persistable) return false;
    const result = await persistCreateAgent(resolvedApi, input, snapshot.policies);
    if (!result.ok) {
      setMessage(failureNotice(result.failure));
      return false;
    }
    await reload();
    return true;
  }, [persistable, reload, resolvedApi, snapshot.policies]);

  const addDepartment = useCallback(async (input: CreateDepartmentInput): Promise<boolean> => {
    if (!persistable) return false;
    const result = await persistCreateDepartment(resolvedApi, input);
    if (!result.ok) {
      setMessage(failureNotice(result.failure));
      return false;
    }
    await reload();
    return true;
  }, [persistable, reload, resolvedApi]);

  /** One server change from a project or department page: notice on failure, reload on success. */
  const runChange = useCallback(async (change: () => Promise<MutationOutcome<unknown>>): Promise<boolean> => {
    if (!persistable) return false;
    const result = await change();
    if (!result.ok) {
      if (result.failure.kind === "revision_conflict") setConflict(result.failure.conflict);
      setMessage(failureNotice(result.failure));
      return false;
    }
    await reload();
    return true;
  }, [persistable, reload]);

  const projectActions = useMemo(() => {
    const revisionOf = (bindingId: string) => snapshot.bindings.find((binding) => binding.id === bindingId)?.revision ?? 1;
    const lifecycle = { requestId: "", expectedRevision: 1, bindingId: "" };
    const input = (bindingId: string) => ({ ...lifecycle, requestId: newRequestId(), expectedRevision: revisionOf(bindingId), bindingId });
    return {
      archive: (bindingId: string) => runChange(() => resolvedApi.archiveProjectBinding(input(bindingId))),
      restore: (bindingId: string) => runChange(() => resolvedApi.restoreProjectBinding(input(bindingId))),
      remove: (bindingId: string) => runChange(() => resolvedApi.deleteProjectBinding(input(bindingId))),
      linkDepartment: (bindingId: string, departmentId: string) =>
        runChange(() => resolvedApi.linkDepartment({ requestId: newRequestId(), bindingId, departmentId })),
      unlinkDepartment: (bindingId: string, departmentId: string) =>
        runChange(() => resolvedApi.unlinkDepartment({ requestId: newRequestId(), bindingId, departmentId })),
      readRules: (bindingId: string) => resolvedApi.readProjectRules({ bindingId }),
      allowAnyCli: (bindingId: string) => runChange(() => persistProjectAnyCli(resolvedApi, snapshot, bindingId)),
      saveRules: (bindingId: string, text: string, expectedHash: string | null) =>
        resolvedApi.saveProjectRules({ requestId: newRequestId(), bindingId, text, expectedHash }),
      setDepartmentAvailability: (departmentId: string, availability: "all" | "selected") =>
        runChange(() =>
          resolvedApi.setDepartmentAvailability({
            requestId: newRequestId(),
            expectedRevision: snapshot.departments.find((item) => item.id === departmentId)?.revision ?? 1,
            departmentId,
            availability,
          }),
        ),
    };
  }, [resolvedApi, runChange, snapshot]);

  const counts = useMemo(() => queueCounts(jobs, snapshot.counts), [jobs, snapshot.counts]);

  return {
    status,
    message,
    setMessage,
    conflict,
    snapshot,
    jobs,
    setJobs,
    agents,
    setAgents,
    departments,
    setDepartments,
    projects,
    setProjects,
    counts,
    reload,
    updateJob,
    addJob,
    addProject,
    addAgent,
    addDepartment,
    updateAgent,
    updateDepartment,
    commitAgent,
    commitDepartment,
    commitProject,
    projectActions,
    catalog,
    catalogError,
    refreshCatalog,
    persistable,
  };
}
