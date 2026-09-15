import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../../components/ui/dialog";
import type { BbCatalog } from "../data/store-commands";
import { advancedCatalogPolicies, catalogEnvironmentOptions, DEFAULT_AGENT_POLICY_HINT, DEFAULT_BINDING_POLICY_HINT, DEFAULT_CATALOG_POLICY, environmentPlacementLabel, policyVersionIdForCreate } from "../data/persist-create";
import { Button, Choice, TextField } from "./shared";

type CreateKind = "project" | "agent" | "department" | null;

export function AgencyCreateDialogs({
  kind,
  onClose,
  catalog,
  catalogError,
  loadCatalog,
  agents,
  bindings,
  createBinding,
  createAgent,
  createDepartment,
}: {
  kind: CreateKind;
  onClose: () => void;
  catalog: BbCatalog;
  catalogError?: string;
  loadCatalog: () => Promise<boolean>;
  agents: { id: string; name: string }[];
  bindings: { id: string; name: string }[];
  createBinding: (input: { bbProjectId: string; environmentId: string; hostId: string; canonicalRoot: string; policyVersionId: string }) => Promise<boolean>;
  createAgent: (input: { name: string; role: string; instructions: string; policyVersionId?: string }) => Promise<boolean>;
  createDepartment: (input: { name: string; leadAgentId: string; instructions: string; acceptance: string; bindingId?: string }) => Promise<boolean>;
}) {
  const [pending, setPending] = useState(false);
  const [loadingCatalog, setLoadingCatalog] = useState(false);
  const [projectId, setProjectId] = useState("");
  const [environmentId, setEnvironmentId] = useState("");
  const [policyId, setPolicyId] = useState("default");
  const [name, setName] = useState("");
  const [role, setRole] = useState("Исполнитель");
  const [instructions, setInstructions] = useState("Выполняйте поручение и приложите проверяемый результат.");
  const [acceptance, setAcceptance] = useState("Результат проверен, файл приложен.");
  const [leadId, setLeadId] = useState("");
  const [bindingId, setBindingId] = useState("none");

  useEffect(() => {
    if (!kind) return;
    setPending(false);
    setName("");
    setRole("Исполнитель");
    setInstructions("Выполняйте поручение и приложите проверяемый результат.");
    setAcceptance("Результат проверен, файл приложен.");
    setProjectId("");
    setEnvironmentId("");
    setPolicyId("default");
    setLeadId("");
    setBindingId("none");
    let live = true;
    setLoadingCatalog(true);
    void loadCatalog().finally(() => {
      if (live) setLoadingCatalog(false);
    });
    return () => {
      live = false;
    };
  }, [kind]);

  useEffect(() => {
    if (!kind || !projectId) return;
    const stillValid = catalog.environments.some((item) => item.id === environmentId && item.projectId === projectId);
    if (stillValid || !environmentId) return;
    setEnvironmentId("");
  }, [kind, projectId, catalog.environments, environmentId]);

  const environment = catalog.environments.find((item) => item.id === environmentId);
  const advancedPolicies = advancedCatalogPolicies(catalog.policies);
  const submit = async () => {
    if (pending) return;
    setPending(true);
    let ok = false;
    if (kind === "project" && environment) {
      ok = await createBinding({
        bbProjectId: projectId,
        environmentId: environment.id,
        hostId: environment.hostId,
        canonicalRoot: environment.path,
        policyVersionId: policyVersionIdForCreate(policyId),
      });
    }
    if (kind === "agent") {
      ok = await createAgent({
        name: name.trim(),
        role: role.trim(),
        instructions: instructions.trim(),
        policyVersionId: policyVersionIdForCreate(policyId) || undefined,
      });
    }
    if (kind === "department") {
      ok = await createDepartment({
        name: name.trim(),
        leadAgentId: leadId,
        instructions: instructions.trim(),
        acceptance: acceptance.trim(),
        bindingId: !bindingId || bindingId === "none" ? undefined : bindingId,
      });
    }
    setPending(false);
    if (ok) onClose();
  };

  const title = kind === "project" ? "Привязать проект" : kind === "agent" ? "Создать сотрудника" : "Создать отдел";
  const description =
    kind === "project"
      ? "Выберите проект BB и рабочую папку. Машина и путь видны в подписи окружения."
      : kind === "agent"
        ? "Создайте профиль сотрудника. Инструкции и настройки можно изменить позже."
        : "Выберите руководителя и проект отдела.";
  const canSubmit =
    kind === "project"
      ? Boolean(projectId && environmentId && environment)
      : kind === "agent"
        ? Boolean(name.trim() && role.trim() && instructions.trim())
        : Boolean(name.trim() && leadId && instructions.trim() && acceptance.trim());

  return (
    <Dialog open={Boolean(kind)} onOpenChange={(open) => { if (!pending && !open) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          {kind === "project" && (
            <>
              <Choice label="Проект BB" value={projectId || "unset"} onChange={(value) => { setProjectId(value === "unset" ? "" : value); setEnvironmentId(""); }} options={[{ value: "unset", label: "Выберите проект" }, ...catalog.projects.map((item) => ({ value: item.id, label: item.name }))]} />
              <Choice label="Рабочая папка" value={environmentId || "unset"} onChange={(value) => setEnvironmentId(value === "unset" ? "" : value)} options={[{ value: "unset", label: "Выберите рабочую папку" }, ...catalogEnvironmentOptions(catalog, projectId)]} />
              {environment && (
                <p className="text-xs text-muted-foreground">
                  Привязка: {environmentPlacementLabel(environment)}. Путь {environment.path}.
                </p>
              )}
              <p className="text-xs text-muted-foreground">{DEFAULT_BINDING_POLICY_HINT}</p>
              {advancedPolicies.length > 0 && (
                <Choice label="Другая запись политики" value={policyId || DEFAULT_CATALOG_POLICY} onChange={setPolicyId} options={[{ value: DEFAULT_CATALOG_POLICY, label: "Обычная · чтение файлов" }, ...advancedPolicies.map((item) => ({ value: item.id, label: item.label }))]} />
              )}
              {loadingCatalog && <p className="text-xs text-muted-foreground">Загружаем каталог проектов…</p>}
              {catalogError && <p className="text-xs text-muted-foreground">{catalogError}</p>}
              {!loadingCatalog && !catalog.projects.length && !catalogError && (
                <p className="text-xs text-muted-foreground">В каталоге BB нет проектов. Создайте проект в BB, затем откройте эту форму снова.</p>
              )}
            </>
          )}
          {kind === "agent" && (
            <>
              <TextField label="Имя" value={name} onChange={setName} />
              <TextField label="Роль" value={role} onChange={setRole} />
              <TextField label="Инструкции" value={instructions} onChange={setInstructions} multiline />
              <p className="text-xs text-muted-foreground">{DEFAULT_AGENT_POLICY_HINT}</p>
              {advancedPolicies.length > 0 && (
                <Choice label="Другая запись политики" value={policyId || DEFAULT_CATALOG_POLICY} onChange={setPolicyId} options={[{ value: DEFAULT_CATALOG_POLICY, label: "Обычная · чтение файлов" }, ...advancedPolicies.map((item) => ({ value: item.id, label: item.label }))]} />
              )}
            </>
          )}
          {kind === "department" && (
            <>
              <TextField label="Название" value={name} onChange={setName} />
              <Choice label="Руководитель" value={leadId || "unset"} onChange={(value) => setLeadId(value === "unset" ? "" : value)} options={[{ value: "unset", label: "Выберите руководителя" }, ...agents.map((item) => ({ value: item.id, label: item.name }))]} />
              {bindings.length > 0 && (
                <Choice label="Проект" value={bindingId || "none"} onChange={setBindingId} options={[{ value: "none", label: "Не подключать сейчас" }, ...bindings.map((item) => ({ value: item.id, label: item.name }))]} />
              )}
              <TextField label="Как работает отдел" value={instructions} onChange={setInstructions} multiline />
              <TextField label="Критерии приёмки" value={acceptance} onChange={setAcceptance} multiline />
              {!agents.length && <p className="text-xs text-muted-foreground">Сначала создайте сотрудника — отделу нужен руководитель.</p>}
            </>
          )}
          <p className="text-xs text-muted-foreground" aria-live="polite">{pending ? "Сохраняем…" : "Поля останутся, пока сервер не подтвердит запись."}</p>
        </div>
        <DialogFooter>
          <Button variant="outline" disabled={pending} onClick={onClose}>Отмена</Button>
          <Button disabled={!canSubmit || pending || (kind === "project" && loadingCatalog)} onClick={() => void submit()}>{pending ? "Сохраняем…" : "Создать"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
