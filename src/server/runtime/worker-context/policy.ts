import type { WorkerContextPolicy, FrozenWorkerContext, VkSessionPolicy } from "../../../shared/contracts/worker-context";
export type ContextSelection = {policy:WorkerContextPolicy;departmentRevision:number;agentRevision:number};
export function freezeWorkerContext(input: ContextSelection | null | undefined, skills: readonly {name?:string;role:string}[], pluginIds: readonly string[], requiredPluginIds: readonly string[] = []): FrozenWorkerContext | undefined {
 if(!input) return undefined;
 if(input.policy.skills?.mode === "assigned" && skills.some(s=>!s.name)) throw new Error("worker_context_skill_name_missing: cannot resolve assigned skills by name");
 const policy: VkSessionPolicy = {};
 for(const key of ["skills","bbPlugins","mcpServers","nativePlugins"] as const) {
  const rule = input.policy[key]; if(!rule) continue;
  const assigned = key === "skills" ? skills.map(s=>s.name).filter((s):s is string=>!!s) : [...pluginIds];
  const required = key === "skills" ? ["agency", ...skills.filter(s=>s.role!=="method").map(s=>s.name).filter((s):s is string=>!!s)] : key === "bbPlugins" ? ["agency",...requiredPluginIds] : [];
  const mode = rule.mode === "assigned" ? "allow" : rule.mode;
  let list = rule.mode === "assigned" ? [...assigned,...rule.names] : [...rule.names];
  if(mode === "allow") list.push(...required);
  else if(required.some(name => list.some(pattern=>matches(pattern,name)))) throw new Error(`worker_context_required: ${key} excludes an Agency service dependency`);
  policy[key] = {mode,names:[...new Set(list)].sort()};
 }
 for(const key of ["userInstructions","projectInstructions","claudeAiSync"] as const) if(input.policy[key] !== undefined) policy[key] = input.policy[key];
 return {policy,departmentRevision:input.departmentRevision,agentRevision:input.agentRevision};
}
export function matches(pattern: string, name: string): boolean { return pattern.endsWith("*") ? name.startsWith(pattern.slice(0,-1)) : pattern===name; }

export function contextAllows(rule: VkSessionPolicy["skills"], name: string): boolean {
 if(!rule)return true;
 const listed=rule.names.some(pattern=>matches(pattern,name));
 return rule.mode==="allow"?listed:!listed;
}
