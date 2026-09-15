import type { BbPluginApi, PluginRpcHandlers } from "@get-bb/plugin-sdk";
import { STAGE1_CONTRACT_VERSION } from "../../shared/contracts";
import { fail, ok, type DomainResult } from "../../domain";
import { rpcContract } from "../../shared/rpc-contract";
import { assessIsolation } from "../runtime/isolation";
import type { DomainStore, ServiceContext } from "../services";
import type { SqlDatabase } from "../db/sql";
import { createSdkHostFilePortFromBinding, joinUnderRoot, type HostFileRpcClient } from "../../host";
import { attachJobInput } from "../runtime/prepare-run/job-input.js";
import { answerNeedsInput } from "../runtime/needs-input/answer.js";
import { readNeedsInputRecord, reportNeedsInput } from "../runtime/needs-input/report.js";
import type { IsolatedSendPort } from "../runtime/isolated-sdk/send-port.js";
import { flushParentWakes } from "../runtime/parent-wake";
import { createInternalRunStoreReads, createRunStore } from "../runtime/run-store";
import { hashBytes } from "../../host/guarded-fs";
import { createArtifactStorage, type ArtifactMetadataPort } from "../artifacts";
import { createArtifactMetadataPort } from "../services";
import {
  activityActorFromContext,
  publishAuthorFromActor,
  resolveRpcAccess,
  verifyCreateBindingPlacement,
  type RpcAccess,
} from "./auth";
import { labelBinding, loadProvisioningCatalog, toBbCatalog } from "./bb-catalog";
import { emptyCapabilityCatalog, loadCapabilityCatalog } from "./capability-catalog";
import { resolveArtifactPreview } from "./resolve-preview";
import {
  countJobsByState,
  listArtifactIdsForJob,
  listJobsForBindings,
  listCurrentAgentVersions,
  listCurrentProcessVersions,
  listStoredAgents,
  listStoredBindings,
  listStoredDepartments,
  listStoredMemberships,
  listStoredPolicies,
  listStoredProjectDepartments,
} from "./catalog";

type DomainMethod =
  | "listWorkspace"
  | "listBbCatalog"
  | "listCapabilityCatalog"
  | "getJob"
  | "getAgent"
  | "getDepartment"
  | "listActivity"
  | "listArtifactVersions"
  | "createPolicyVersion"
  | "createAgentVersion"
  | "createProcessVersion"
  | "saveAgentProfile"
  | "saveDepartmentProfile"
  | "provisionAgent"
  | "updateAgent"
  | "provisionDepartment"
  | "updateDepartment"
  | "addMembership"
  | "removeMembership"
  | "createProjectBinding"
  | "updateProjectBinding"
  | "linkDepartment"
  | "createJob"
  | "updateJob"
  | "transitionJob"
  | "createActivity"
  | "createArtifact"
  | "publishArtifactVersion"
  | "attachJobInput"
  | "reportNeedsInput"
  | "answerNeedsInput"
  | "acceptArtifactVersion"
  | "openArtifact"
  | "resolveArtifactPreview";

type DomainHandlers = Pick<PluginRpcHandlers<typeof rpcContract>, DomainMethod>;

function isolationNote() {
  return {
    catalogSkillsIsolated: false as const,
    catalogMcpIsolated: false as const,
    execution: "unavailable" as const,
    reason: assessIsolation().reason,
  };
}

function asResult<T>(result: DomainResult<T>): DomainResult<T> {
  return result;
}

export function createDomainRpc(deps: {
  bb: BbPluginApi;
  store: DomainStore;
  db: SqlDatabase;
  onChanged: () => void;
  documents: HostFileRpcClient;
  createMetadataPort?: (ctx: ServiceContext) => ArtifactMetadataPort;
  send?: IsolatedSendPort;
}): DomainHandlers {
  const { bb, store, db, onChanged, documents } = deps;
  const runs = createRunStore(db);
  const reads = createInternalRunStoreReads(db);
  const createMetadataPort = deps.createMetadataPort ?? ((ctx: ServiceContext) => createArtifactMetadataPort(db, ctx));

  function storageFor(ctx: ServiceContext, binding: { hostId: string; canonicalRoot: string }) {
    const files = createSdkHostFilePortFromBinding(documents, binding);
    if (!files.ok) return files;
    return ok(
      createArtifactStorage({
        metadata: createMetadataPort(ctx),
        files: files.value,
        previewFiles: files.value,
        previewRoot: binding.canonicalRoot,
      }),
    );
  }

  async function withAccess<T>(run: (access: RpcAccess) => DomainResult<T> | Promise<DomainResult<T>>): Promise<DomainResult<T>> {
    const access = resolveRpcAccess(db);
    if (!access.ok) return access;
    return run(access.value);
  }

  function mutated<T>(result: DomainResult<T>): DomainResult<T> {
    if (result.ok) onChanged();
    return result;
  }

  async function labeledBindings(bindings: ReturnType<typeof listStoredBindings>) {
    if (bindings.length === 0) {
      return bindings.map((binding) => ({ ...binding, ...labelBinding(binding, undefined) }));
    }
    const catalog = await loadProvisioningCatalog(bb, db);
    return bindings.map((binding) => ({
      ...binding,
      ...labelBinding(binding, catalog.ok ? catalog.value : undefined),
    }));
  }

  return {
    listWorkspace: (input) =>
      withAccess(async (access) => {
        let bindingIds = [...access.ctx.allowedBindingIds];
        if (input.bindingId) {
          const allowed = store.assertBindingAccess(access.ctx, input.bindingId);
          if (!allowed.ok) return allowed;
          bindingIds = [input.bindingId];
        }
        const stored = listStoredBindings(db).filter((binding) => bindingIds.includes(binding.id));
        const scoped = input.claimedBbProjectId
          ? stored.filter((binding) => binding.bbProjectId === input.claimedBbProjectId)
          : stored;
        if (input.claimedBbProjectId && scoped.length === 0) {
          return fail("untrusted_project", "payload projectId does not match a binding in trusted SDK scope");
        }
        const bindings = await labeledBindings(scoped);
        const agents = listStoredAgents(db);
        const departments = listStoredDepartments(db);
        const scopedIds = scoped.map((binding) => binding.id);
        return ok({
          contractVersion: STAGE1_CONTRACT_VERSION,
          isolation: isolationNote(),
          bindings,
          jobs: listJobsForBindings(db, scopedIds),
          counts: countJobsByState(db, scopedIds),
          agents,
          departments,
          memberships: listStoredMemberships(db),
          agentVersions: listCurrentAgentVersions(db, agents),
          processVersions: listCurrentProcessVersions(db, departments),
          projectDepartments: listStoredProjectDepartments(db, scopedIds),
          policies: listStoredPolicies(db),
        });
      }),

    listBbCatalog: () =>
      withAccess(async () => {
        const catalog = await loadProvisioningCatalog(bb, db);
        if (!catalog.ok) return catalog;
        const capabilities = await loadCapabilityCatalog(
          bb,
          {
            projectId: catalog.value.projects[0]?.id,
            environmentId: catalog.value.environments.find((row) => row.projectId === catalog.value.projects[0]?.id)?.id ?? null,
          },
          db,
        );
        const discovered = capabilities.ok ? capabilities.value : emptyCapabilityCatalog();
        return ok({
          ...toBbCatalog(catalog.value),
          skills: discovered.skills,
          mcps: discovered.mcps,
          skillDiscovery: discovered.skillDiscovery,
          mcpDiscovery: discovered.mcpDiscovery,
        });
      }),

    listCapabilityCatalog: (input) => withAccess(() => loadCapabilityCatalog(bb, input, db)),

    getJob: (input) =>
      withAccess((access) => {
        const job = input.jobId ? store.getJob(input.jobId) : input.key ? store.getJobByKey(input.key) : undefined;
        if (!job) return fail("not_found", "job not found");
        const scoped = store.scopedJob(access.ctx, job.id, input.claimedBbProjectId);
        if (!scoped.ok) return scoped;
        const artifactIds = listArtifactIdsForJob(db, job.id);
        return ok({
          job: scoped.value.job,
          binding: scoped.value.binding,
          activity: store.listActivity(job.id),
          dependencies: store.listDependencies(job.id),
          artifacts: artifactIds.map((artifactId) => ({
            artifact: { id: artifactId, jobId: job.id },
            versions: store.listArtifactVersions(artifactId, job.id),
          })),
          needsInput: readNeedsInputRecord(db, job.id),
        });
      }),

    getAgent: (input) =>
      withAccess(() => {
        const agent = store.getAgent(input.agentId);
        if (!agent) return fail("not_found", `agent ${input.agentId} not found`);
        const version = store.getAgentVersion(agent.currentVersionId);
        return ok({ agent, version, isolation: isolationNote() });
      }),

    getDepartment: (input) =>
      withAccess(() => {
        const department = store.getDepartment(input.departmentId);
        if (!department) return fail("not_found", `department ${input.departmentId} not found`);
        return ok({
          department,
          process: store.getProcessVersion(department.processVersionId),
          memberships: store.listMemberships(department.id),
        });
      }),

    listActivity: (input) =>
      withAccess((access) => {
        const scoped = store.scopedJob(access.ctx, input.jobId, input.claimedBbProjectId);
        if (!scoped.ok) return scoped;
        return ok(store.listActivity(input.jobId));
      }),

    listArtifactVersions: (input) =>
      withAccess((access) => {
        const scoped = store.scopedJob(access.ctx, input.jobId, input.claimedBbProjectId);
        if (!scoped.ok) return scoped;
        const artifact = store.getArtifact(input.artifactId);
        if (!artifact || artifact.jobId !== input.jobId) {
          return fail("artifact_scope_mismatch", "artifact does not belong to this job");
        }
        return ok(store.listArtifactVersions(input.artifactId, input.jobId));
      }),

    createPolicyVersion: (input) => withAccess((access) => mutated(store.createPolicyVersion(access.ctx, input))),
    createAgentVersion: (input) => withAccess((access) => mutated(store.createAgentVersion(access.ctx, input))),
    createProcessVersion: (input) => withAccess((access) => mutated(store.createProcessVersion(access.ctx, input))),
    saveAgentProfile: (input) => withAccess((access) => mutated(store.saveAgentProfile(access.ctx, input))),
    saveDepartmentProfile: (input) => withAccess((access) => mutated(store.saveDepartmentProfile(access.ctx, input))),
    provisionAgent: (input) => withAccess((access) => mutated(store.provisionAgent(access.ctx, input))),
    updateAgent: (input) => withAccess((access) => mutated(store.updateAgent(access.ctx, input))),
    provisionDepartment: (input) => withAccess((access) => mutated(store.provisionDepartment(access.ctx, input))),
    updateDepartment: (input) => withAccess((access) => mutated(store.updateDepartment(access.ctx, input))),
    addMembership: (input) => withAccess((access) => mutated(store.addMembership(access.ctx, input))),
    removeMembership: (input) => withAccess((access) => mutated(store.removeMembership(access.ctx, input))),

    createProjectBinding: (input) =>
      withAccess(async (access) => {
        const placed = await verifyCreateBindingPlacement(bb, input);
        if (!placed.ok) return placed;
        return mutated(store.createProjectBinding(access.ctx, input));
      }),

    updateProjectBinding: (input) => withAccess((access) => mutated(store.updateProjectBinding(access.ctx, input))),
    linkDepartment: (input) => withAccess((access) => mutated(store.linkDepartment(access.ctx, input))),
    createJob: (input) => withAccess((access) => mutated(store.createJob(access.ctx, input))),
    updateJob: (input) => withAccess((access) => mutated(store.updateJob(access.ctx, input))),
    transitionJob: (input) =>
      withAccess(async (access) => {
        const result = mutated(store.transitionJob(access.ctx, input));
        if (result.ok && deps.send) {
          await flushParentWakes({ db, send: deps.send, now: new Date().toISOString() });
        }
        return result;
      }),

    createActivity: (input) =>
      withAccess((access) =>
        mutated(
          store.createActivity(access.ctx, {
            ...input,
            actor: activityActorFromContext(access.ctx),
          }),
        ),
      ),

    createArtifact: (input) => withAccess((access) => mutated(store.createArtifact(access.ctx, input))),

    publishArtifactVersion: (input) =>
      withAccess(async (access) => {
        const scoped = store.scopedJob(access.ctx, input.jobId, input.claimedBbProjectId);
        if (!scoped.ok) return scoped;
        const author = publishAuthorFromActor(access.ctx.actor);
        if (!author.ok) return author;
        const bytes = new Uint8Array(Buffer.from(input.bytesBase64, "base64"));
        const actualHash = hashBytes(bytes);
        if (actualHash !== input.hash || bytes.byteLength !== input.size) {
          return fail(
            "artifact_hash_mismatch",
            `claimed ${input.size}/${input.hash} != actual ${bytes.byteLength}/${actualHash}`,
          );
        }
        const storage = storageFor(access.ctx, scoped.value.binding);
        if (!storage.ok) return storage;
        return mutated(
          await storage.value.publish({
            requestId: input.requestId,
            artifactId: input.artifactId,
            jobId: input.jobId,
            hostId: scoped.value.binding.hostId,
            relativePath: input.relativePath,
            mime: input.mime,
            size: bytes.byteLength,
            hash: actualHash,
            author: author.value,
            bytes,
          }),
        );
      }),

    reportNeedsInput: (input) =>
      withAccess(async (access) => {
        const result = mutated(reportNeedsInput({ db, store, runs, reads }, access.ctx, input));
        if (result.ok && deps.send) {
          await flushParentWakes({ db, send: deps.send, now: new Date().toISOString() });
        }
        return result;
      }),

    answerNeedsInput: (input) =>
      withAccess(async (access) => {
        if (!deps.send) {
          return fail("sdk_send_unsupported", "official threads.send is not wired");
        }
        return mutated(
          await answerNeedsInput({ db, store, runs, reads, send: deps.send }, access.ctx, input),
        );
      }),

    attachJobInput: (input) =>
      withAccess(async (access) => {
        const target = store.getJob(input.targetJobId);
        if (!target) return fail("not_found", `target job ${input.targetJobId} not found`);
        const source = store.getJob(input.sourceJobId);
        if (!source) return fail("not_found", `source job ${input.sourceJobId} not found`);
        const binding = store.getBinding(source.bindingId);
        if (!binding) return fail("not_found", `source binding ${source.bindingId} not found`);
        const files = createSdkHostFilePortFromBinding(documents, binding);
        if (!files.ok) return files;
        return mutated(await attachJobInput({ store, db, files: files.value }, access.ctx, input));
      }),

    acceptArtifactVersion: (input) => withAccess((access) => mutated(store.acceptArtifactVersion(access.ctx, input))),

    openArtifact: (input) =>
      withAccess(async (access) => {
        const scoped = store.scopedJob(access.ctx, input.jobId, input.claimedBbProjectId);
        if (!scoped.ok) return scoped;
        const artifact = store.getArtifact(input.artifactId);
        if (!artifact || artifact.jobId !== input.jobId) {
          return fail("artifact_scope_mismatch", "artifact does not belong to this job");
        }
        const storage = storageFor(access.ctx, scoped.value.binding);
        if (!storage.ok) return storage;
        const opened = await storage.value.openOriginal(input.artifactId, input.jobId, input.version);
        if (!opened.ok) return opened;
        const preview = await storage.value.createPreview(input.artifactId, input.jobId, input.version);
        if (!preview.ok) return preview;
        const targetPath = joinUnderRoot(scoped.value.binding.canonicalRoot, preview.value.relativePath);
        if (!targetPath.ok) return targetPath;
        return ok({
          hostId: opened.value.version.hostId,
          size: opened.value.version.size,
          hash: opened.value.version.hash,
          bytesBase64: Buffer.from(opened.value.bytes).toString("base64"),
          target: {
            hostId: opened.value.version.hostId,
            path: targetPath.value,
          },
        });
      }),

    resolveArtifactPreview: (input) =>
      withAccess((access) => resolveArtifactPreview(store, db, access.ctx, input)),
  };
}
