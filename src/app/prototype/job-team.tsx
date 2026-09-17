import { useEffect, useState } from "react";
import { Button, Field } from "./shared";
import type { Job } from "./data";
import type { AssigneeCatalogAgent } from "../data/job-placement";
import {
  TEAM_ATTEMPT_HINT,
  TEAM_ROLES_PENDING,
  TEAM_UNASSIGNED,
  TEAM_UNASSIGNED_ONE,
  addTeamAgentId,
  currentWorkLabel,
  historicalAttemptNote,
  parseJobTeamRoles,
  removeTeamAgentId,
  resolveJobTeam,
  sameAgentIdList,
  type AttemptStatus,
  type JobTeamPerson,
} from "../data/job-team";
import { UNASSIGNED_AGENT, assigneeChoiceOptions } from "../data/job-placement";
import { tr } from "../i18n";

const PICK = "__pick_team_agent__";

function PersonValue({
  person,
  onOpen,
}: {
  person: JobTeamPerson;
  onOpen?: (id: string) => void;
}) {
  if (!person) return <span>{TEAM_UNASSIGNED_ONE}</span>;
  if (person.id && onOpen) {
    return (
      <Button size="sm" variant="ghost" className="h-auto px-0 text-left" onClick={() => onOpen(person.id)}>
        {person.name}
      </Button>
    );
  }
  return <span>{person.name}</span>;
}

function RoleList({
  people,
  pending,
  onOpen,
}: {
  people: readonly { id: string; name: string }[];
  pending: boolean;
  onOpen?: (id: string) => void;
}) {
  if (pending || people.length === 0) return <span>{TEAM_UNASSIGNED}</span>;
  return (
    <ul className="space-y-1">
      {people.map((person) => (
        <li key={person.id}>
          <PersonValue person={person} onOpen={onOpen} />
        </li>
      ))}
    </ul>
  );
}

function RolePicker({
  label,
  ids,
  agents,
  options,
  disabled,
  onChange,
  onOpen,
}: {
  label: string;
  ids: readonly string[];
  agents: readonly { id: string; name: string }[];
  options: { value: string; label: string }[];
  disabled?: boolean;
  onChange: (ids: string[]) => void;
  onOpen?: (id: string) => void;
}) {
  const addable = options.filter((item) => item.value !== PICK && !ids.includes(item.value));
  return (
    <div className="space-y-1">
      {ids.length === 0 ? (
        <span>{TEAM_UNASSIGNED}</span>
      ) : (
        <ul className="space-y-1">
          {ids.map((id) => {
            const name = agents.find((agent) => agent.id === id)?.name ?? id;
            return (
              <li key={id} className="flex items-center justify-between gap-2">
                <PersonValue person={{ id, name }} onOpen={onOpen} />
                <Button size="sm" variant="ghost" disabled={disabled} onClick={() => onChange(removeTeamAgentId(ids, id))}>
                  {tr("Убрать")}
                </Button>
              </li>
            );
          })}
        </ul>
      )}
      {addable.length > 0 && (
        <select
          aria-label={tr("Добавить: {label}", { label })}
          className="w-full min-w-0 rounded-md border border-border bg-background px-2 py-0.5"
          disabled={disabled}
          value={PICK}
          onChange={(event) => {
            const value = event.target.value;
            if (value === PICK) return;
            onChange(addTeamAgentId(ids, value));
          }}
        >
          <option value={PICK}>{tr("Добавить из отдела")}</option>
          {addable.map((item) => (
            <option key={item.value} value={item.value}>{item.label}</option>
          ))}
        </select>
      )}
      {ids.length > 0 && (
        <Button size="sm" variant="ghost" disabled={disabled} onClick={() => onChange([])}>
          {tr("Очистить")}
        </Button>
      )}
    </div>
  );
}

export function JobTeamBlock({
  job,
  agents,
  projects,
  departments,
  attempt,
  demoMode = false,
  persistPending = false,
  openAgent,
  onPersistRoles,
}: {
  job: Job;
  agents: AssigneeCatalogAgent[];
  projects: { id: string; name: string }[];
  departments: { id: string; name: string; lead?: string; members?: readonly string[] }[];
  attempt?: AttemptStatus;
  demoMode?: boolean;
  persistPending?: boolean;
  openAgent?: (id: string) => void;
  onPersistRoles?: (next: { reviewerAgentIds: string[]; observerAgentIds: string[] }) => void | Promise<boolean>;
}) {
  const stored = parseJobTeamRoles(job);
  const [draftReviewers, setDraftReviewers] = useState<string[]>(() => [...stored.reviewerIds]);
  const [draftWatchers, setDraftWatchers] = useState<string[]>(() => [...stored.watcherIds]);
  const storedKey = `${stored.reviewerIds.join(",")}|${stored.watcherIds.join(",")}`;
  const dirty =
    !sameAgentIdList(draftReviewers, stored.reviewerIds) || !sameAgentIdList(draftWatchers, stored.watcherIds);
  useEffect(() => {
    if (dirty) return;
    setDraftReviewers((current) => (sameAgentIdList(current, stored.reviewerIds) ? current : [...stored.reviewerIds]));
    setDraftWatchers((current) => (sameAgentIdList(current, stored.watcherIds) ? current : [...stored.watcherIds]));
  }, [dirty, storedKey, stored.reviewerIds, stored.watcherIds]);
  const team = resolveJobTeam({
    job,
    projects,
    departments,
    agents,
    roles: { reviewerIds: draftReviewers, watcherIds: draftWatchers },
    attempt,
    demoFallback: demoMode,
  });
  const memberOptions = assigneeChoiceOptions(job.departmentId, departments, agents).filter((item) => item.value !== UNASSIGNED_AGENT);
  const commit = async (reviewerAgentIds: string[], observerAgentIds: string[]) => {
    setDraftReviewers(reviewerAgentIds);
    setDraftWatchers(observerAgentIds);
    if (!onPersistRoles) return;
    await onPersistRoles({ reviewerAgentIds, observerAgentIds });
  };
  const pickers = Boolean(onPersistRoles) && !demoMode;
  const historical = historicalAttemptNote({ job, assigned: team.assigned, attempt });
  return (
    <section aria-label={tr("Команда")} data-testid="job-team-block" className="agency-rail-section space-y-2">
      <h3>{tr("Команда")}</h3>
      <Field label="Руководитель">
        <PersonValue person={team.lead} onOpen={openAgent} />
      </Field>
      <Field label="Кто работает" info={<p>{tr("Исполнитель задачи и состояние его последнего запуска.")}</p>}>
        <span>{currentWorkLabel({ job, assigned: team.assigned, attemptLabel: team.attemptLabel })}</span>
      </Field>
      <Field label="Проверяющие" info={<><p>{tr("Кто из отдела проверяет результат этой задачи. Руководитель назначает проверку подзадачей на проверяющего.")}</p><p>{tr("Исполнитель не может быть проверяющим своей задачи.")}</p></>}>
        {pickers ? (
          <RolePicker
            label="проверяющего"
            ids={draftReviewers}
            agents={agents}
            options={memberOptions.filter((item) => item.value !== job.assignedAgentId)}
            disabled={persistPending}
            onChange={(ids) => void commit(ids, draftWatchers)}
            onOpen={openAgent}
          />
        ) : (
          <RoleList people={team.reviewers} pending={team.reviewersPending} onOpen={openAgent} />
        )}
      </Field>
      <Field label="Наблюдатели" info={<p>{tr("Кого держать в курсе задачи. Наблюдатель ничего не исполняет и не принимает.")}</p>}>
        {pickers ? (
          <RolePicker
            label="наблюдателя"
            ids={draftWatchers}
            agents={agents}
            options={memberOptions}
            disabled={persistPending}
            onChange={(ids) => void commit(draftReviewers, ids)}
            onOpen={openAgent}
          />
        ) : (
          <RoleList people={team.watchers} pending={team.watchersPending} onOpen={openAgent} />
        )}
      </Field>
      <details className="text-xs text-muted-foreground">
        <summary className="cursor-pointer">{tr("Технические подробности")}</summary>
        <p className="mt-1">{tr(TEAM_ATTEMPT_HINT)}</p>
        {historical && <p className="mt-1">{historical}</p>}
        {demoMode && (team.reviewersPending || team.watchersPending) && <p className="mt-1">{tr(TEAM_ROLES_PENDING)}</p>}
      </details>
    </section>
  );
}
