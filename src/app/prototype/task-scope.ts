import type { Job } from "./data";

export interface TaskScope { kind: "all"|"attention"|"active"|"project"|"department"|"agent"; value?:string; }
export function inTaskScope(job:Job,scope:TaskScope) {
 switch(scope.kind) {
  case "attention": return job.state==="blocked"||job.state==="waiting_input";
  case "active": return job.state==="running";
  case "project": return job.bindingId===scope.value||job.project===scope.value;
  case "department": return job.departmentId===scope.value||job.department===scope.value;
  case "agent": return job.assignedAgentId===scope.value||job.agent===scope.value;
  default:return true;
 }
}
export function scopeTitle(scope:TaskScope) {return scope.kind==="all"?"Все задачи":scope.kind==="attention"?"Требуют внимания":scope.kind==="active"?"В работе":`Задачи · ${scope.value}`;}
