import { Button, Status } from "./shared";
import type { Job } from "./data";
import {
  MAIN_JOB_LABEL,
  jobParentBreadcrumb,
  jobTree,
  visibleJobDependencies,
  type JobDependencyEdge,
  type JobTreeNode,
} from "../data/job-tree";
import { tr } from "../i18n";

function cleanJobTitle(id: string, title: string): string {
  if (title.startsWith(id)) {
    return title.slice(id.length).replace(/^[\s:—–-]+/, "");
  }
  return title;
}

function TreeRows({
  node,
  depth,
  openJob,
}: {
  node: JobTreeNode;
  depth: number;
  openJob: (id: string) => void;
}) {
  const root = depth === 0;
  return (
    <>
      <button
        type="button"
        data-testid={node.current ? "job-tree-current" : `job-tree-${node.job.id}`}
        aria-current={node.current ? "page" : undefined}
        onClick={() => openJob(node.job.id)}
        className={`agency-task-tree-row min-h-10 w-full rounded-md px-2 py-1.5 text-left hover:bg-muted/40 focus-visible:outline focus-visible:outline-ring ${node.current ? "bg-muted" : ""}`}
        style={{ paddingLeft: `${8 + depth * 12}px` }}
      >
        {root && <span className="agency-task-tree-root-label">{tr(MAIN_JOB_LABEL)}</span>}
        <span className="agency-task-tree-row-head">
          <span className="agency-task-tree-row-key">{node.job.id}</span>
          <span className="agency-task-tree-row-title">{cleanJobTitle(node.job.id, node.job.title)}</span>
        </span>
        <span className="agency-task-tree-row-meta">
          <Status state={node.job.state} />
          <span className="agency-task-tree-row-agent text-muted-foreground">{node.job.agent || tr("Не назначен")}</span>
        </span>
      </button>
      {node.children.map((child) => (
        <TreeRows key={child.job.id} node={child} depth={depth + 1} openJob={openJob} />
      ))}
    </>
  );
}

export function JobTreePanel({
  job,
  jobs,
  dependencies,
  openJob,
}: {
  job: Job;
  jobs: Job[];
  dependencies: readonly JobDependencyEdge[];
  openJob: (id: string) => void;
}) {
  const tree = jobTree(jobs, job);
  const breadcrumb = jobParentBreadcrumb(jobs, job);
  const links = visibleJobDependencies(dependencies, jobs, job);
  return (
    <div className="space-y-4" data-testid="job-tree-panel">
      <section aria-label={tr("Иерархия задачи")}>
        <h2 className="mb-2 text-xs font-semibold">{tr("Иерархия")}</h2>
        {breadcrumb.length > 0 && (
          <nav aria-label={tr("Родительские задачи")} className="agency-task-tree-crumb" data-testid="job-tree-breadcrumb">
            {breadcrumb.map((item, index) => (
              <span key={item.id} className="inline-flex min-w-0 items-baseline gap-1">
                {index > 0 && <span aria-hidden className="text-muted-foreground">›</span>}
                <Button size="sm" variant="ghost" className="h-auto max-w-full truncate px-0 text-xs" onClick={() => openJob(item.id)}>
                  {index === 0 ? tr(MAIN_JOB_LABEL) : item.title}
                </Button>
              </span>
            ))}
          </nav>
        )}
        <TreeRows node={tree} depth={0} openJob={openJob} />
      </section>
      <section aria-label={tr("Связанные задачи")} data-testid="job-links-panel" className="border-t border-border pt-3">
        <h2 className="mb-2 text-xs font-semibold">{tr("Связанные задачи")}</h2>
        {links.dependsOn.length === 0 && links.blockersOf.length === 0 ? (
          <p className="text-xs text-muted-foreground">{tr("Зависимостей в записи нет.")}</p>
        ) : (
          <div className="space-y-3">
            {links.dependsOn.length > 0 && (
              <div>
                <p className="mb-1 text-xs text-muted-foreground">{tr("Зависит от")}</p>
                {links.dependsOn.map((link) => (
                  link.known ? (
                    <Button key={link.id} size="sm" variant="ghost" className="h-auto w-full justify-start px-0 text-left whitespace-normal" onClick={() => openJob(link.id)}>
                      {link.title}
                    </Button>
                  ) : (
                    <p key={link.id} className="font-mono text-xs text-muted-foreground">{link.id}</p>
                  )
                ))}
              </div>
            )}
            {links.blockersOf.length > 0 && (
              <div>
                <p className="mb-1 text-xs text-muted-foreground">{tr("Блокирует")}</p>
                {links.blockersOf.map((link) => (
                  link.known ? (
                    <Button key={link.id} size="sm" variant="ghost" className="h-auto w-full justify-start px-0 text-left whitespace-normal" onClick={() => openJob(link.id)}>
                      {link.title}
                    </Button>
                  ) : (
                    <p key={link.id} className="font-mono text-xs text-muted-foreground">{link.id}</p>
                  )
                ))}
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
