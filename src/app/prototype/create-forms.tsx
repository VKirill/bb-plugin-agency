import { useEffect, useRef, useState } from "react";
import { experimental_ProviderModelPicker as ProviderModelPicker, type ExperimentalProviderModelPickerValue } from "@get-bb/plugin-sdk/app";
import { LAUNCH_PROVIDER_ID, REASONING_OPTIONS, ROLE_TYPE_OPTIONS, TITLE_PLACEHOLDER, type ReasoningLevel, type RoleType } from "../data/role-types";
import { jobDescriptionTemplate } from "../data/instruction-templates";
import { useTemplates } from "./use-templates";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../../components/ui/dialog";
import type { BbCatalog } from "../data/store-commands";
import { advancedCatalogPolicies, catalogEnvironmentOptions, DEFAULT_AGENT_POLICY_HINT, DEFAULT_BINDING_POLICY_HINT, DEFAULT_CATALOG_POLICY, environmentPlacementLabel, policyVersionIdForCreate } from "../data/persist-create";
import { Button, Checks, Choice, Field, HintedChoice, TextField } from "./shared";
import { charterIssues } from "../data/charter";
import { providerLaunchNote, useLaunchableProviders } from "./use-launchable-providers";
import { FALLBACK_ROLE_DEFAULTS, useRoleDefaults } from "./use-role-defaults";
import { tr } from "../i18n";

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
  departments = [],
  routingHostId,
  existingDepartmentNames = departments.map((item) => item.name),
}: {
  kind: CreateKind;
  onClose: () => void;
  catalog: BbCatalog;
  catalogError?: string;
  loadCatalog: () => Promise<boolean>;
  agents: { id: string; name: string; role?: string; enabled?: boolean; selection?: { providerId: string; model: string } }[];
  bindings: { id: string; name: string; archivedAt?: string; environmentId?: string; root?: string }[];
  departments?: { id: string; name: string }[];
  /** Machine whose model catalog the picker reads. */
  routingHostId?: string;
  existingDepartmentNames?: string[];
  createBinding: (input: { bbProjectId: string; environmentId: string; hostId: string; canonicalRoot: string; policyVersionId: string }) => Promise<boolean>;
  createAgent: (input: {
    name: string;
    role: string;
    instructions: string;
    policyVersionId?: string;
    providerId?: string;
    model?: string;
    reasoningEffort?: ReasoningLevel;
    departmentId?: string;
    roleType?: "executor" | "reviewer";
  }) => Promise<boolean>;
  createDepartment: (input: { name: string; leadAgentId: string; instructions: string; acceptance: string; bindingId?: string; executorIds?: string[]; reviewerIds?: string[] }) => Promise<boolean>;
}) {
  const [pending, setPending] = useState(false);
  const launchableProviders = useLaunchableProviders();
  // Starting model and reasoning per role type come from «Настройки → Правила работы».
  const roleDefaults = useRoleDefaults(kind === "agent");
  // Starting texts from «Настройки → Шаблоны».
  const templates = useTemplates();
  const appliedTemplates = useRef(templates);
  useEffect(() => {
    const previous = appliedTemplates.current;
    appliedTemplates.current = templates;
    if (previous === templates) return;
    // The owner's templates arrived after the form opened: replace the starting text the person has not touched.
    if (kind === "agent" && !instructionsTouched) setInstructions(jobDescriptionTemplate(roleType, templates));
    if (kind === "department") setInstructions((current) => (current === previous.charter ? templates.charter : current));
  }, [templates]);
  const DEFAULT_MODEL = roleDefaults.model;
  const DEFAULT_REASONING = roleDefaults.reasoning;
  const appliedDefaults = useRef(FALLBACK_ROLE_DEFAULTS);
  const [loadingCatalog, setLoadingCatalog] = useState(false);
  const [projectId, setProjectId] = useState("");
  const [environmentId, setEnvironmentId] = useState("");
  const [policyId, setPolicyId] = useState("default");
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [roleType, setRoleType] = useState<RoleType>("executor");
  const [agentDepartment, setAgentDepartment] = useState("none");
  const [selection, setSelection] = useState<ExperimentalProviderModelPickerValue>({ providerId: LAUNCH_PROVIDER_ID, model: DEFAULT_MODEL.executor, reasoningLevel: DEFAULT_REASONING.executor });
  const [reasoning, setReasoning] = useState<ReasoningLevel>(DEFAULT_REASONING.executor);
  const [instructionsTouched, setInstructionsTouched] = useState(false);
  const [instructions, setInstructions] = useState("Выполняйте поручение и приложите проверяемый результат.");
  const [acceptance, setAcceptance] = useState("Результат проверен, файл приложен.");
  const [leadId, setLeadId] = useState("");
  const [executorIds, setExecutorIds] = useState<string[]>([]);
  const [reviewerIds, setReviewerIds] = useState<string[]>([]);
  const [bindingId, setBindingId] = useState("none");

  useEffect(() => {
    if (!kind) return;
    setPending(false);
    setName("");
    setRole("");
    setRoleType("executor");
    setAgentDepartment("none");
    setSelection({ providerId: LAUNCH_PROVIDER_ID, model: DEFAULT_MODEL.executor, reasoningLevel: DEFAULT_REASONING.executor });
    setReasoning(DEFAULT_REASONING.executor);
    setInstructionsTouched(false);
    setInstructions(kind === "agent" ? jobDescriptionTemplate("executor", templates) : "Выполняйте поручение и приложите проверяемый результат.");
    setAcceptance("Результат проверен, файл приложен.");
    setProjectId("");
    setEnvironmentId("");
    setPolicyId("default");
    setLeadId("");
    setExecutorIds([]);
    setReviewerIds([]);
    setBindingId("none");
    if (kind === "department") {
      setInstructions(templates.charter);
      setAcceptance("");
    }
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
    const previous = appliedDefaults.current;
    appliedDefaults.current = roleDefaults;
    if (kind !== "agent" || previous === roleDefaults) return;
    setSelection((current) => (current.model === previous.model[roleType] ? { ...current, model: roleDefaults.model[roleType], reasoningLevel: roleDefaults.reasoning[roleType] } : current));
    setReasoning((current) => (current === previous.reasoning[roleType] ? roleDefaults.reasoning[roleType] : current));
  }, [roleDefaults]);

  useEffect(() => {
    if (!kind || !projectId) return;
    const stillValid = catalog.environments.some((item) => item.id === environmentId && item.projectId === projectId);
    if (stillValid || !environmentId) return;
    setEnvironmentId("");
  }, [kind, projectId, catalog.environments, environmentId]);

  const environment = catalog.environments.find((item) => item.id === environmentId);
  // Only an active employee on the launched CLI can lead or work in a department.
  const launchable = agents.filter((agent) => agent.enabled !== false && (!agent.selection || launchableProviders.includes(agent.selection.providerId)));
  const nameTaken = kind === "department" && existingDepartmentNames.some((item) => item.trim().toLocaleLowerCase("ru") === name.trim().toLocaleLowerCase("ru")) && Boolean(name.trim());
  const issues = kind === "department" ? charterIssues(instructions) : [];
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
      const joinsDepartment = roleType !== "lead" && agentDepartment !== "none";
      ok = await createAgent({
        name: name.trim(),
        role: role.trim(),
        instructions: instructions.trim(),
        policyVersionId: policyVersionIdForCreate(policyId) || undefined,
        providerId: selection.providerId,
        model: selection.model,
        reasoningEffort: reasoning,
        ...(joinsDepartment ? { departmentId: agentDepartment, roleType: roleType === "reviewer" ? "reviewer" : "executor" } : {}),
      });
    }
    if (kind === "department") {
      ok = await createDepartment({
        name: name.trim(),
        leadAgentId: leadId,
        instructions: instructions.trim(),
        acceptance: acceptance.trim(),
        executorIds: executorIds.filter((id) => id !== leadId),
        reviewerIds: reviewerIds.filter((id) => id !== leadId && !executorIds.includes(id)),
      });
    }
    setPending(false);
    if (ok) onClose();
  };

  const title = kind === "project" ? tr("Привязать проект") : kind === "agent" ? tr("Создать сотрудника") : tr("Создать отдел");
  const description =
    kind === "project"
      ? tr("Выберите проект BB и рабочую папку. Машина и путь видны в подписи окружения.")
      : kind === "agent"
        ? tr("Создайте профиль сотрудника. Инструкции и настройки можно изменить позже.")
        : tr("Отдел — команда с руководителем, регламентом и составом. Принимает задачи из любого подключённого проекта.");
  const canSubmit =
    kind === "project"
      ? Boolean(projectId && environmentId && environment)
      : kind === "agent"
        ? Boolean(name.trim() && role.trim() && instructions.trim() && selection.model.trim())
        : Boolean(name.trim() && leadId && instructions.trim() && acceptance.trim() && charterIssues(instructions).length === 0 && !nameTaken);

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
              <Choice label="Рабочая папка" value={environmentId || "unset"} onChange={(value) => setEnvironmentId(value === "unset" ? "" : value)} options={[{ value: "unset", label: "Выберите рабочую папку" }, ...catalogEnvironmentOptions(catalog, projectId, bindings)]} />
              {projectId && !loadingCatalog && !catalogEnvironmentOptions(catalog, projectId, bindings).length && (
                <p className="text-xs text-muted-foreground">{tr("У проекта нет свободной рабочей папки. Папка появляется после первого треда в этом проекте BB; уже подключённые папки здесь не показываются.")}</p>
              )}
              {environment && (
                <p className="text-xs text-muted-foreground">
                  {tr("Привязка: {label}. Путь {path}.", { label: environmentPlacementLabel(environment), path: environment.path })}
                </p>
              )}
              <p className="text-xs text-muted-foreground">{tr(DEFAULT_BINDING_POLICY_HINT)}</p>
              {advancedPolicies.length > 0 && (
                <Choice label="Другая запись политики" value={policyId || DEFAULT_CATALOG_POLICY} onChange={setPolicyId} options={[{ value: DEFAULT_CATALOG_POLICY, label: "Обычная · чтение файлов" }, ...advancedPolicies.map((item) => ({ value: item.id, label: item.label }))]} />
              )}
              {loadingCatalog && <p className="text-xs text-muted-foreground">{tr("Загружаем каталог проектов…")}</p>}
              {catalogError && <p className="text-xs text-muted-foreground">{tr(catalogError)}</p>}
              {!loadingCatalog && !catalog.projects.length && !catalogError && (
                <p className="text-xs text-muted-foreground">{tr("В каталоге BB нет проектов. Создайте проект в BB, затем откройте эту форму снова.")}</p>
              )}
            </>
          )}
          {kind === "agent" && (
            <div className="max-h-[65dvh] space-y-3 overflow-y-auto pr-1">
              <TextField label="Имя" value={name} onChange={setName} maxLength={80} required placeholder="Как сотрудника видят в отделе и задачах" />
              <HintedChoice
                label="Тип роли"
                required
                value={roleType}
                onChange={(next) => {
                  setRoleType(next);
                  setReasoning(DEFAULT_REASONING[next]);
                  setSelection((current) => ({ ...current, reasoningLevel: DEFAULT_REASONING[next], model: current.model === DEFAULT_MODEL[roleType] ? DEFAULT_MODEL[next] : current.model }));
                  if (!instructionsTouched) setInstructions(jobDescriptionTemplate(next, templates));
                }}
                options={ROLE_TYPE_OPTIONS}
                info={<><p>{tr("Тип роли определяет, что система делает с сотрудником: какие инструкции он получит при запуске и какие действия ему доступны.")}</p><p>{tr("Тип закрепляется в составе отдела. Один сотрудник может быть исполнителем в одном отделе и проверяющим в другом.")}</p></>}
              />
              {roleType === "lead" ? (
                <p className="rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground">{tr("Руководителя назначают в отделе: выберите этого сотрудника при создании отдела или в «Составе» существующего отдела.")}</p>
              ) : (
                <Field label="Отдел" info={<><p>{tr("Сотрудник сразу войдёт в состав отдела с выбранным типом роли.")}</p><p>{tr("Без отдела ему нельзя поручить задачу: исполнитель задачи всегда из состава её отдела.")}</p></>}>
                  <Choice label="Отдел" value={agentDepartment} onChange={setAgentDepartment} options={[{ value: "none", label: "Не добавлять сейчас" }, ...departments.map((item) => ({ value: item.id, label: item.name }))]} />
                </Field>
              )}
              <TextField label="Должность" value={role} onChange={setRole} maxLength={80} required placeholder={TITLE_PLACEHOLDER[roleType]} info={<><p>{tr("Свободный текст на языке команды: как эту работу называют у вас. Показывается в карточках и в инструкциях руководителю.")}</p><p>{tr("На поведение системы влияет тип роли, а не должность.")}</p></>} />
              <Field label="CLI и модель" required info={<><p>{tr("Любой провайдер, подключённый в BB. Запуск задач Агентство сейчас выполняет только для CLI с подтверждённым изолированным запуском — иначе форма предупредит.")}</p><p>{tr("Сильная модель нужна руководителю и проверяющему, для типовой работы исполнителя хватает более быстрой и дешёвой.")}</p></>}>
                <ProviderModelPicker
                  value={selection}
                  onChange={(next) => {
                    setSelection({ providerId: next.providerId, model: next.model, reasoningLevel: next.reasoningLevel });
                    if (REASONING_OPTIONS.some((option) => option.value === next.reasoningLevel)) setReasoning(next.reasoningLevel as ReasoningLevel);
                  }}
                  routing={routingHostId ? { kind: "host", hostId: routingHostId } : undefined}
                  allowProviderChange
                  align="start"
                />
                {providerLaunchNote(selection.providerId, launchableProviders) && <p className="text-xs text-amber-700 dark:text-amber-400">{providerLaunchNote(selection.providerId, launchableProviders)}</p>}
              </Field>
              <HintedChoice
                label="Уровень рассуждения"
                value={reasoning}
                onChange={(next) => { setReasoning(next); setSelection((current) => ({ ...current, reasoningLevel: next })); }}
                options={REASONING_OPTIONS}
                info={<><p>{tr("Сколько модель думает перед ответом. Выше — точнее решения, но дороже и медленнее.")}</p><p>{tr("Значения по умолчанию для каждого типа роли задаются в «Настройки → Правила работы».")}</p></>}
              />
              <TextField
                label="Должностная инструкция"
                value={instructions}
                onChange={(value) => { setInstructions(value); setInstructionsTouched(true); }}
                multiline
                rows={8}
                required
                info={<><p>{tr("Что входит в работу сотрудника и что нет, кому возвращать чужое, какие входы нужны, какой результат и как себя проверить.")}</p><p>{tr("Шаблон подставлен по типу роли: замените примеры в угловых скобках на свои.")}</p></>}
              />
              <p className="text-xs text-muted-foreground">{tr(DEFAULT_AGENT_POLICY_HINT)} {tr("Навыки Агентства подключаются к запуску автоматически.")}</p>
              {advancedPolicies.length > 0 && (
                <details className="text-xs">
                  <summary className="cursor-pointer text-muted-foreground hover:text-foreground">{tr("Другие права")}</summary>
                  <div className="mt-2">
                    <Choice label="Политика прав" value={policyId || DEFAULT_CATALOG_POLICY} onChange={setPolicyId} options={[{ value: DEFAULT_CATALOG_POLICY, label: "Стандартные: файлы проекта · Claude Code" }, ...advancedPolicies.map((item) => ({ value: item.id, label: item.label }))]} />
                  </div>
                </details>
              )}
            </div>
          )}
          {kind === "department" && (
            <div className="max-h-[65dvh] space-y-3 overflow-y-auto pr-1">
              <TextField label="Название" value={name} onChange={setName} maxLength={80} required placeholder="Например: Разработка" hint={nameTaken ? "Отдел с таким названием уже есть: агенты не смогут их различить." : undefined} info={<><p>{tr("По названию и разделу «Принимаем» агенты в чатах выбирают, какому отделу поручить работу. Названия отделов не повторяются.")}</p></>} />
              <Field label="Руководитель" required info={<><p>{tr("Получает все задачи отдела, оценивает их, раздаёт подзадачи исполнителям и проверяющим и собирает итог.")}</p><p>{tr("В списке только активные сотрудники на CLI, который Агентство может запустить ({providers}). Нет подходящего — сначала создайте сотрудника.", { providers: launchableProviders.join(", ") })}</p></>}>
                <Choice label="Руководитель" value={leadId || "unset"} onChange={(value) => setLeadId(value === "unset" ? "" : value)} options={[{ value: "unset", label: "Выберите руководителя" }, ...launchable.map((item) => ({ value: item.id, label: item.role ? `${item.name} · ${item.role}` : item.name }))]} />
              </Field>
              {launchable.length > 1 && (
                <>
                  <Field label="Исполнители" info={<><p>{tr("Делают работу по поручениям и сдают версии результата.")}</p></>}>
                    <Checks options={launchable.filter((item) => item.id !== leadId && !reviewerIds.includes(item.id)).map((item) => ({ value: item.id, label: item.role ? `${item.name} · ${item.role}` : item.name }))} selected={executorIds} onChange={setExecutorIds} />
                  </Field>
                  <Field label="Проверяющие" info={<><p>{tr("Независимо проверяют чужие версии. Без проверяющего руководитель проверяет результат сам.")}</p></>}>
                    <Checks options={launchable.filter((item) => item.id !== leadId && !executorIds.includes(item.id)).map((item) => ({ value: item.id, label: item.role ? `${item.name} · ${item.role}` : item.name }))} selected={reviewerIds} onChange={setReviewerIds} />
                  </Field>
                </>
              )}
              <TextField
                label="Регламент отдела"
                value={instructions}
                onChange={setInstructions}
                multiline
                rows={10}
                required
                info={<><p>{tr("Что отдел принимает и не принимает, какие входы нужны, процесс, эскалация.")}</p><p>{tr("Раздел «## Принимаем» обязателен: по нему любой чат BB решает, поручить ли работу этому отделу. Сотрудники получают регламент при каждом запуске.")}</p></>}
              />
              {issues.length > 0 && <ul className="space-y-1 rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground">{issues.map((issue) => <li key={issue}>{tr("Регламент: {issue}.", { issue: tr(issue) })}</li>)}</ul>}
              <TextField label="Критерии приёмки результата" value={acceptance} onChange={setAcceptance} multiline rows={3} required placeholder="Например: report.md опубликован версией; тесты и сборка проходят; есть заключение проверяющего без открытых дефектов." info={<><p>{tr("Общий для всех задач отдела класс результата: формат, обязательные проверки, публикация версией.")}</p><p>{tr("Конкретные признаки пишутся в каждой задаче отдельно.")}</p></>} />
              <p className="text-xs text-muted-foreground">{tr("Новый отдел доступен во всех проектах. Ограничить выбранными проектами можно в его настройках.")}</p>
              {!launchable.length && <p className="text-xs text-muted-foreground">{tr("Нет активных сотрудников на Claude Code. Сначала создайте сотрудника — отделу нужен руководитель.")}</p>}
            </div>
          )}
          {pending && <p className="text-xs text-muted-foreground" aria-live="polite">{tr("Сохраняем…")}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" disabled={pending} onClick={onClose}>{tr("Отмена")}</Button>
          <Button disabled={!canSubmit || pending || (kind === "project" && loadingCatalog)} onClick={() => void submit()}>{pending ? tr("Сохраняем…") : tr("Создать")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
