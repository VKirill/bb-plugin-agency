import type { ReactNode } from "react";
import { Button, InfoHint } from "./shared";
import { shortAgentName } from "../data/agent-name";
import { tr } from "../i18n";

/**
 * Right rail primitives of the task card.
 *
 * The rail is read-only: it states the current placement, team, files and
 * runtime of the job. Every change goes through the header "Редактировать"
 * dialog, so the rail never mixes labels with form controls.
 */
export function RailCard({
  title,
  action,
  label,
  children,
}: {
  title: string;
  action?: ReactNode;
  label?: string;
  children: ReactNode;
}) {
  return (
    <section aria-label={tr(label ?? title)} className="agency-rail-card">
      <div className="agency-rail-card-head">
        <h3 className="agency-rail-card-title">{tr(title)}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

export function RailRow({
  label,
  value,
  tone = "default",
  mono = false,
  info,
}: {
  label: string;
  value: ReactNode;
  tone?: "default" | "muted" | "success";
  mono?: boolean;
  info?: ReactNode;
}) {
  const toneClass = tone === "muted" ? " agency-rail-value-muted" : tone === "success" ? " agency-rail-value-success" : "";
  return (
    <div className="agency-rail-row">
      <span className="agency-rail-label inline-flex items-center gap-0.5">{tr(label)}{info && <InfoHint title={label} className="size-4">{info}</InfoHint>}</span>
      <span className={`agency-rail-value${toneClass}${mono ? " agency-rail-value-mono" : ""}`}>{value}</span>
    </div>
  );
}

/** Agent name in the rail: a link when the person can be opened, plain text otherwise. */
export function RailPerson({
  person,
  open,
  short = false,
}: {
  person: { id: string; name: string };
  open?: (id: string) => void;
  short?: boolean;
}) {
  const label = short ? shortAgentName(person.name) : person.name;
  if (person.id && open) {
    return (
      <Button size="sm" variant="ghost" className="h-auto px-0" aria-label={person.name} onClick={() => open(person.id)}>
        {label}
      </Button>
    );
  }
  return <span title={person.name}>{label}</span>;
}
