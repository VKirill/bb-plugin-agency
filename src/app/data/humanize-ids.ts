/**
 * Briefs written by agents carry technical ids (`agt_…`, `dep_…`, `bnd_…`,
 * `job_…`). The card shows the names people know; an unknown id stays as is.
 */
export type IdNames = {
  agents: readonly { id: string; name: string }[];
  departments: readonly { id?: string; recordId?: string; name: string }[];
  projects: readonly { id?: string; recordId?: string; name: string }[];
  jobs: readonly { id: string; recordId?: string }[];
};

const ID_PATTERN = /\b(agt|dep|bnd|job)_[a-z0-9]{8,40}\b/g;

export function humanizeIds(text: string, names: IdNames): string {
  const lookup = new Map<string, string>();
  for (const agent of names.agents) lookup.set(agent.id, agent.name);
  for (const department of names.departments) {
    const id = department.recordId ?? department.id;
    if (id) lookup.set(id, `отдел «${department.name}»`);
  }
  for (const project of names.projects) {
    const id = project.recordId ?? project.id;
    if (id) lookup.set(id, `проект «${project.name}»`);
  }
  for (const job of names.jobs) if (job.recordId) lookup.set(job.recordId, job.id);
  return text.replace(ID_PATTERN, (id, _kind, offset: number, whole: string) => {
    const name = lookup.get(id);
    if (!name) return id;
    // Inside inline code the id is probably meant to be copied: keep it and add the name.
    const before = whole.slice(0, offset);
    const inCode = (before.match(/`/g)?.length ?? 0) % 2 === 1;
    return inCode ? id : name;
  });
}
