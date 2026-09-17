import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { migrations } from "../src/server/db/migrations";
import { openMigratedDatabase, type SqlDatabase } from "../src/server/db";
import { createArtifactMetadataPort, createDomainStore, type ServiceContext } from "../src/server/services";
import { createArtifactStorage, withCommitFailure } from "../src/server/artifacts";
import type { ArtifactPublishReservation } from "../src/server/artifacts/metadata-port";
import { createLocalHostFilePort, originalRelativePath } from "../src/host";

const hashA = "a".repeat(64);
const hashB = "b".repeat(64);
const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function requestId(): string {
  return randomUUID();
}

function openFileDb(): { db: SqlDatabase; path: string; close: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "agy6-"));
  tempDirs.push(dir);
  const path = join(dir, "agency.sqlite");
  const db = openMigratedDatabase(new Database(path));
  return {
    db,
    path,
    close: () => db.close(),
  };
}

function reopen(path: string): SqlDatabase {
  return openMigratedDatabase(new Database(path));
}

function ctxFor(bindingId: string): ServiceContext {
  return { actor: { kind: "user", userId: "user_kirill" }, allowedBindingIds: [bindingId] };
}

async function seedProject(db: SqlDatabase, options?: { canonicalRoot?: string }) {
  const store = createDomainStore(db);
  const bootstrap: ServiceContext = { actor: { kind: "system" }, allowedBindingIds: [] };
  const policy = store.createPolicyVersion(bootstrap, {
    requestId: requestId(),
    allowedCapabilities: ["read.files"],
    cliHostConstraints: { providerIds: ["codex"], hostIds: ["host_mini"] },
    secretRefs: ["OPENAI_API_KEY"],
  });
  if (!policy.ok) throw new Error(policy.error.message);
  const agent = store.provisionAgent(bootstrap, {
    requestId: requestId(),
    name: "Редактор",
    state: "active",
    version: {
      version: 1,
      role: "editor",
      instructions: "Править тексты по брифу.",
      providerId: "codex",
      model: "gpt-5.6",
      skillIds: ["skill_6153a163fb7fac8c435f3befc88db8417cd0722ba8fdf5ecc37b2b5069ffc3ff"],
      mcpIds: [],
      policyVersionId: policy.value.id,
    },
  });
  if (!agent.ok) throw new Error(agent.error.message);
  const department = store.provisionDepartment(bootstrap, {
    requestId: requestId(),
    name: "Редактура",
    leadAgentId: agent.value.agent.id,
    process: {
      instructions: "Черновик, затем проверка.",
      acceptance: "Есть принятая версия файла.",
      reviewPolicy: { required: true },
    },
  });
  if (!department.ok) throw new Error(department.error.message);
  const binding = store.createProjectBinding(bootstrap, {
    requestId: requestId(),
    bbProjectId: "proj_trusted",
    environmentId: "env_ucx7sb57rs",
    hostId: "host_mini",
    canonicalRoot: options?.canonicalRoot ?? "/Users/vechkasov/Documents/SelfyStudio",
    policyVersionId: policy.value.id,
    sectionId: null,
  });
  if (!binding.ok) throw new Error(binding.error.message);
  const ctx = ctxFor(binding.value.id);
  const linked = store.linkDepartment(ctx, {
    requestId: requestId(),
    bindingId: binding.value.id,
    departmentId: department.value.department.id,
  });
  if (!linked.ok) throw new Error(linked.error.message);
  const job = store.createJob(ctx, {
    requestId: requestId(),
    key: "AG-101",
    bindingId: binding.value.id,
    departmentId: department.value.department.id,
    title: "Карточка услуги",
    brief: "Собрать карточку.",
    acceptance: "Текст принят.",
    parentJobId: null,
    assignedAgentId: agent.value.agent.id,
    priority: "normal",
    dueAt: null,
  });
  if (!job.ok) throw new Error(job.error.message);
  return {
    store,
    ctx,
    policy: policy.value,
    agent: agent.value.agent,
    department: department.value.department,
    binding: binding.value,
    job: job.value,
  };
}

function reservation(
  jobId: string,
  bindingId: string,
  extra: Partial<ArtifactPublishReservation> = {},
): ArtifactPublishReservation {
  return {
    requestId: extra.requestId ?? requestId(),
    artifactId: extra.artifactId ?? "art_aaaaaaaa",
    jobId,
    bindingId,
    hostId: extra.hostId ?? "host_mini",
    canonicalRoot: extra.canonicalRoot ?? "/Users/vechkasov/Documents/SelfyStudio",
    bindingRevision: extra.bindingRevision ?? 1,
    relativePath: extra.relativePath ?? "card.md",
    mime: extra.mime ?? "text/markdown",
    size: extra.size ?? 12,
    hash: extra.hash ?? hashA,
    author: extra.author ?? { kind: "user", userId: "user_kirill" },
  };
}

describe("agency domain storage", () => {
  it("keeps the shipped inbox migration and does not seed entities", () => {
    expect(migrations[0]).toContain("CREATE TABLE agency_inbox");
    expect(migrations[0]).toContain("CHECK(state = 'pending')");
    const { db, close } = openFileDb();
    try {
      const store = createDomainStore(db);
      expect(store.inboxCount()).toBe(0);
      expect(store.getJobByKey("AG-101")).toBeUndefined();
      expect(
        (db.prepare("SELECT count(*) AS n FROM agency_agent").get() as { n: number }).n,
      ).toBe(0);
    } finally {
      close();
    }
  });

  it("survives restart and rejects stale revisions", async () => {
    const opened = openFileDb();
    const first = await seedProject(opened.db);
    opened.close();
    const db = reopen(opened.path);
    try {
      const store = createDomainStore(db);
      const job = store.getJob(first.job.id);
      expect(job?.title).toBe("Карточка услуги");
      expect(job?.bindingId).toBe(first.binding.id);
      const stale = store.updateJob(first.ctx, {
        requestId: requestId(),
        jobId: first.job.id,
        expectedRevision: (job?.revision ?? 1) + 1,
        title: "Чужое окно",
      });
      expect(stale.ok).toBe(false);
      if (!stale.ok) expect(stale.error.code).toBe("revision_conflict");
      const updated = store.updateJob(first.ctx, {
        requestId: requestId(),
        jobId: first.job.id,
        expectedRevision: job?.revision ?? 1,
        title: "Карточка после reload",
      });
      expect(updated.ok).toBe(true);
    } finally {
      db.close();
    }
  });

  it("isolates bindings and claimedBbProjectId is not authorization", async () => {
    const { db, close } = openFileDb();
    try {
      const seeded = await seedProject(db);
      const other = seeded.store.createProjectBinding(
        { actor: { kind: "system" }, allowedBindingIds: [] },
        {
          requestId: requestId(),
          bbProjectId: "proj_other",
          environmentId: "env_other0001",
          hostId: "host_mini",
          canonicalRoot: "/Users/vechkasov/Documents/Other",
          policyVersionId: seeded.policy.id,
          sectionId: null,
        },
      );
      expect(other.ok).toBe(true);
      if (!other.ok) return;
      const outsider = ctxFor(other.value.id);
      const stolen = seeded.store.updateJob(outsider, {
        requestId: requestId(),
        jobId: seeded.job.id,
        expectedRevision: 1,
        title: "Чжой проект",
      });
      expect(stolen.ok).toBe(false);
      if (!stolen.ok) expect(stolen.error.code).toBe("forbidden_binding");
      const claimed = seeded.store.updateJob(seeded.ctx, {
        requestId: requestId(),
        jobId: seeded.job.id,
        expectedRevision: 1,
        claimedBbProjectId: "proj_other",
        title: "Подмена projectId",
      });
      expect(claimed.ok).toBe(false);
      if (!claimed.ok) expect(claimed.error.code).toBe("untrusted_project");
    } finally {
      close();
    }
  });

  it("keeps the previous assignee when department changes and blocks binding moves with deps", async () => {
    const { db, close } = openFileDb();
    try {
      const seeded = await seedProject(db);
      const reviewer = seeded.store.provisionAgent(
        { actor: { kind: "system" }, allowedBindingIds: [] },
        {
          requestId: requestId(),
          name: "Рецензент",
          state: "active",
          version: {
            version: 1,
            role: "reviewer",
            instructions: "Проверять.",
            providerId: "codex",
            model: "gpt-5.6",
            skillIds: ["skill_6153a163fb7fac8c435f3befc88db8417cd0722ba8fdf5ecc37b2b5069ffc3ff"],
            mcpIds: [],
            policyVersionId: seeded.policy.id,
          },
        },
      );
      expect(reviewer.ok).toBe(true);
      if (!reviewer.ok) return;
      const reviewDept = seeded.store.provisionDepartment(
        { actor: { kind: "system" }, allowedBindingIds: [] },
        {
          requestId: requestId(),
          name: "Проверка",
          leadAgentId: reviewer.value.agent.id,
          process: {
            instructions: "Проверить.",
            acceptance: "Нет замечаний.",
            reviewPolicy: { required: true },
          },
        },
      );
      expect(reviewDept.ok).toBe(true);
      if (!reviewDept.ok) return;
      expect(
        seeded.store.linkDepartment(seeded.ctx, {
          requestId: requestId(),
          bindingId: seeded.binding.id,
          departmentId: reviewDept.value.department.id,
        }).ok,
      ).toBe(true);
      expect(
        seeded.store.updateJob(seeded.ctx, {
          requestId: requestId(),
          jobId: seeded.job.id,
          expectedRevision: seeded.job.revision,
          departmentId: reviewDept.value.department.id,
        }),
      ).toMatchObject({ ok: false, error: { code: "assignee_not_member" } });

      const other = seeded.store.createProjectBinding(
        { actor: { kind: "system" }, allowedBindingIds: [] },
        {
          requestId: requestId(),
          bbProjectId: "proj_other",
          environmentId: "env_other01aaaa",
          hostId: "host_mini",
          canonicalRoot: "/Users/vechkasov/Documents/OtherStudio",
          policyVersionId: seeded.policy.id,
          sectionId: null,
        },
      );
      expect(other.ok).toBe(true);
      if (!other.ok) return;
      const otherCtx = { actor: { kind: "system" as const }, allowedBindingIds: [seeded.binding.id, other.value.id] };
      expect(
        seeded.store.linkDepartment(otherCtx, {
          requestId: requestId(),
          bindingId: other.value.id,
          departmentId: reviewDept.value.department.id,
        }).ok,
      ).toBe(true);
      const sibling = seeded.store.createJob(seeded.ctx, {
        requestId: requestId(),
        key: "AG-109",
        bindingId: seeded.binding.id,
        departmentId: seeded.department.id,
        title: "Сосед",
        brief: "Связь.",
        acceptance: "Связь есть.",
        parentJobId: null,
        assignedAgentId: null,
        priority: "normal",
        dueAt: null,
      });
      expect(sibling.ok).toBe(true);
      if (!sibling.ok) return;
      expect(
        seeded.store.addJobDependency(seeded.ctx, {
          requestId: requestId(),
          jobId: sibling.value.id,
          dependsOnJobId: seeded.job.id,
        }).ok,
      ).toBe(true);
      expect(
        seeded.store.updateJob(otherCtx, {
          requestId: requestId(),
          jobId: seeded.job.id,
          expectedRevision: seeded.job.revision,
          bindingId: other.value.id,
          departmentId: reviewDept.value.department.id,
          assignedAgentId: reviewer.value.agent.id,
        }),
      ).toMatchObject({ ok: false, error: { code: "job_has_dependencies" } });
      expect(seeded.store.getJob(seeded.job.id)?.bindingId).toBe(seeded.binding.id);
    } finally {
      close();
    }
  });

  it("rolls back a cyclic dependency and blocks queued/running while deps are open", async () => {
    const { db, close } = openFileDb();
    try {
      const seeded = await seedProject(db);
      const child = seeded.store.createJob(seeded.ctx, {
        requestId: requestId(),
        key: "AG-102",
        bindingId: seeded.binding.id,
        departmentId: seeded.department.id,
        title: "Зависимая",
        brief: "Ждёт родителя.",
        acceptance: "Родитель принят.",
        parentJobId: seeded.job.id,
        assignedAgentId: seeded.agent.id,
        priority: "normal",
        dueAt: null,
      });
      expect(child.ok).toBe(true);
      if (!child.ok) return;
      const edge = seeded.store.addJobDependency(seeded.ctx, {
        requestId: requestId(),
        jobId: child.value.id,
        dependsOnJobId: seeded.job.id,
      });
      expect(edge.ok).toBe(true);
      const cycle = seeded.store.addJobDependency(seeded.ctx, {
        requestId: requestId(),
        jobId: seeded.job.id,
        dependsOnJobId: child.value.id,
      });
      expect(cycle.ok).toBe(false);
      if (!cycle.ok) expect(cycle.error.code).toBe("dependency_cycle");
      expect(seeded.store.listDependencies(seeded.job.id)).toEqual([]);
      const queued = seeded.store.transitionJob(seeded.ctx, {
        requestId: requestId(),
        jobId: child.value.id,
        expectedRevision: 1,
        to: "queued",
      });
      expect(queued.ok).toBe(false);
      if (!queued.ok) expect(queued.error.code).toBe("open_blockers");
      seeded.store.transitionJob(seeded.ctx, {
        requestId: requestId(),
        jobId: child.value.id,
        expectedRevision: 1,
        to: "blocked",
      });
      const sneak = seeded.store.transitionJob(seeded.ctx, {
        requestId: requestId(),
        jobId: child.value.id,
        expectedRevision: 2,
        to: "queued",
      });
      expect(sneak.ok).toBe(false);
      if (!sneak.ok) expect(sneak.error.code).toBe("open_blockers");
    } finally {
      close();
    }
  });

  it("reserves versions from pending intents and conflicts on a different payload", async () => {
    const { db, close } = openFileDb();
    try {
      const seeded = await seedProject(db);
      const artifact = seeded.store.createArtifact(seeded.ctx, { requestId: requestId(), jobId: seeded.job.id });
      expect(artifact.ok).toBe(true);
      if (!artifact.ok) return;
      const port = createArtifactMetadataPort(db, seeded.ctx);
      if (!port.reservePublish) throw new Error("reservePublish is required");
      const reservePublish = port.reservePublish.bind(port);
      const first = await reservePublish(reservation(seeded.job.id, seeded.binding.id, {
        artifactId: artifact.value.id,
        requestId: requestId(),
      }));
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      expect(first.value.version).toBe(1);
      expect(first.value.state).toBe("pending");
      const second = await reservePublish(reservation(seeded.job.id, seeded.binding.id, {
        artifactId: artifact.value.id,
        requestId: requestId(),
        hash: hashB,
      }));
      expect(second.ok).toBe(true);
      if (!second.ok) return;
      expect(second.value.version).toBe(2);
      expect(await port.listVersions({ artifactId: artifact.value.id, jobId: seeded.job.id })).toEqual([]);
      const conflict = await reservePublish(reservation(seeded.job.id, seeded.binding.id, {
        artifactId: artifact.value.id,
        requestId: first.value.requestId,
        hash: hashB,
      }));
      expect(conflict.ok).toBe(false);
      if (!conflict.ok) expect(conflict.error.code).toBe("request_conflict");
    } finally {
      close();
    }
  });

  it("continues a reserved pending intent in SQL without writing bytes", async () => {
    const { db, close } = openFileDb();
    try {
      const seeded = await seedProject(db);
      const artifact = seeded.store.createArtifact(seeded.ctx, { requestId: requestId(), jobId: seeded.job.id });
      expect(artifact.ok).toBe(true);
      if (!artifact.ok) return;
      const port = createArtifactMetadataPort(db, seeded.ctx);
      if (!port.reservePublish) throw new Error("reservePublish is required");
      const reservePublish = port.reservePublish.bind(port);
      const request = requestId();
      const reserved = await reservePublish(reservation(seeded.job.id, seeded.binding.id, {
        artifactId: artifact.value.id,
        requestId: request,
      }));
      expect(reserved.ok).toBe(true);
      if (!reserved.ok) return;
      const moved = seeded.store.updateProjectBinding(seeded.ctx, {
        requestId: requestId(),
        bindingId: seeded.binding.id,
        expectedRevision: 1,
        policyVersionId: seeded.policy.id,
      });
      expect(moved.ok).toBe(true);
      const live = await port.getBinding(seeded.binding.id);
      expect(live?.revision).toBe(2);
      const liveRetry = await reservePublish(reservation(seeded.job.id, seeded.binding.id, {
        artifactId: artifact.value.id,
        requestId: request,
        bindingRevision: live?.revision,
        canonicalRoot: live?.canonicalRoot,
      }));
      expect(liveRetry.ok).toBe(false);
      const pending = await reservePublish(reservation(seeded.job.id, seeded.binding.id, {
        artifactId: artifact.value.id,
        requestId: request,
        canonicalRoot: reserved.value.canonicalRoot,
        bindingRevision: reserved.value.bindingRevision,
      }));
      expect(pending.ok).toBe(true);
      if (!pending.ok) return;
      expect(pending.value.version).toBe(1);
      expect(pending.value.state).toBe("pending");
      expect(pending.value.hostId).toBe("host_mini");
      expect(pending.value.canonicalRoot).toBe("/Users/vechkasov/Documents/SelfyStudio");
      expect(pending.value.bindingRevision).toBe(1);
      const version = {
        artifactId: artifact.value.id,
        jobId: seeded.job.id,
        version: 1,
        hostId: "host_mini",
        relativePath: "card.md",
        mime: "text/markdown",
        size: 12,
        hash: hashA,
        author: { kind: "user" as const, userId: "user_kirill" },
      };
      const committed = await port.commitVersion(pending.value, version);
      expect(committed.ok).toBe(true);
      const again = await port.commitVersion(pending.value, version);
      expect(again.ok).toBe(true);
    } finally {
      close();
    }
  });

  it("does not treat requestId as authorization across kind, job or scope", async () => {
    const { db, close } = openFileDb();
    try {
      const seeded = await seedProject(db);
      const reused = requestId();
      const first = seeded.store.updateJob(seeded.ctx, {
        requestId: reused,
        jobId: seeded.job.id,
        expectedRevision: 1,
        title: "Первая правка",
      });
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      const replay = seeded.store.updateJob(seeded.ctx, {
        requestId: reused,
        jobId: seeded.job.id,
        expectedRevision: 1,
        title: "Первая правка",
      });
      expect(replay.ok).toBe(true);
      if (replay.ok) expect(replay.value.revision).toBe(first.value.revision);

      const otherKind = seeded.store.createArtifact(seeded.ctx, {
        requestId: reused,
        jobId: seeded.job.id,
      });
      expect(otherKind.ok).toBe(false);
      if (!otherKind.ok) expect(otherKind.error.code).toBe("request_conflict");

      const otherJob = seeded.store.createJob(seeded.ctx, {
        requestId: requestId(),
        key: "AG-103",
        bindingId: seeded.binding.id,
        departmentId: seeded.department.id,
        title: "Вторая задача",
        brief: "Другой бриф.",
        acceptance: "Другой критерий.",
        parentJobId: null,
        assignedAgentId: seeded.agent.id,
        priority: "normal",
        dueAt: null,
      });
      expect(otherJob.ok).toBe(true);
      if (!otherJob.ok) return;
      const otherJobReuse = seeded.store.updateJob(seeded.ctx, {
        requestId: reused,
        jobId: otherJob.value.id,
        expectedRevision: 1,
        title: "Чужой job",
      });
      expect(otherJobReuse.ok).toBe(false);
      if (!otherJobReuse.ok) expect(otherJobReuse.error.code).toBe("request_conflict");

      const changedPayload = seeded.store.updateJob(seeded.ctx, {
        requestId: reused,
        jobId: seeded.job.id,
        expectedRevision: 1,
        title: "Другой текст",
      });
      expect(changedPayload.ok).toBe(false);
      if (!changedPayload.ok) expect(changedPayload.error.code).toBe("request_conflict");

      const otherBinding = seeded.store.createProjectBinding(
        { actor: { kind: "system" }, allowedBindingIds: [] },
        {
          requestId: requestId(),
          bbProjectId: "proj_scope2",
          environmentId: "env_scope0002",
          hostId: "host_mini",
          canonicalRoot: "/Users/vechkasov/Documents/OtherScope",
          policyVersionId: seeded.policy.id,
          sectionId: null,
        },
      );
      expect(otherBinding.ok).toBe(true);
      if (!otherBinding.ok) return;
      const outsider = ctxFor(otherBinding.value.id);
      const crossScope = seeded.store.updateJob(outsider, {
        requestId: reused,
        jobId: seeded.job.id,
        expectedRevision: 1,
        title: "Первая правка",
      });
      expect(crossScope.ok).toBe(false);
      if (!crossScope.ok) expect(crossScope.error.code).toBe("forbidden_binding");
      const stolenCatalog = seeded.store.createPolicyVersion(outsider, {
        requestId: reused,
        allowedCapabilities: ["read.files"],
        cliHostConstraints: { providerIds: ["codex"], hostIds: ["host_mini"] },
        secretRefs: ["OPENAI_API_KEY"],
      });
      expect(stolenCatalog.ok).toBe(false);
      if (!stolenCatalog.ok) expect(stolenCatalog.error.code).toBe("forbidden_binding");
      expect(seeded.store.getJob(seeded.job.id)?.title).toBe("Первая правка");
    } finally {
      close();
    }
  });

  it("rejects commit of a terminal failed publish intent", async () => {
    const { db, close } = openFileDb();
    try {
      const seeded = await seedProject(db);
      const artifact = seeded.store.createArtifact(seeded.ctx, { requestId: requestId(), jobId: seeded.job.id });
      expect(artifact.ok).toBe(true);
      if (!artifact.ok) return;
      const port = createArtifactMetadataPort(db, seeded.ctx);
      if (!port.reservePublish) throw new Error("reservePublish is required");
      const reserved = await port.reservePublish(reservation(seeded.job.id, seeded.binding.id, {
        artifactId: artifact.value.id,
      }));
      expect(reserved.ok).toBe(true);
      if (!reserved.ok) return;
      const failed = await port.markIntentFailed(reserved.value.requestId, "bytes_write_failed");
      expect(failed.ok).toBe(true);
      const committed = await port.commitVersion(reserved.value, {
        artifactId: artifact.value.id,
        jobId: seeded.job.id,
        version: reserved.value.version,
        hostId: "host_mini",
        relativePath: "card.md",
        mime: "text/markdown",
        size: 12,
        hash: hashA,
        author: { kind: "user", userId: "user_kirill" },
      });
      expect(committed.ok).toBe(false);
      if (!committed.ok) expect(committed.error.code).toBe("intent_failed");
      expect(port.getVersion({ artifactId: artifact.value.id, jobId: seeded.job.id }, reserved.value.version)).resolves.toBeUndefined();
    } finally {
      close();
    }
  });

  it("persists an optional activity comment through the service", async () => {
    const { db, close } = openFileDb();
    try {
      const seeded = await seedProject(db);
      const saved = seeded.store.createActivity(seeded.ctx, {
        requestId: requestId(),
        jobId: seeded.job.id,
        actor: { kind: "user", userId: "user_kirill" },
        kind: "review_returned",
        causationId: null,
        references: [{ type: "job", id: seeded.job.id }],
        comment: "Вернуть: нет критерия приёмки.",
      });
      expect(saved.ok).toBe(true);
      if (!saved.ok) return;
      expect(saved.value.comment).toBe("Вернуть: нет критерия приёмки.");
      const listed = seeded.store.listActivity(seeded.job.id);
      expect(listed.some((row) => row.comment === "Вернуть: нет критерия приёмки.")).toBe(true);
    } finally {
      close();
    }
  });
});

describe("artifact storage integration sqlite+fs", () => {
  function workspace(): string {
    const dir = mkdtempSync(join(tmpdir(), "agy6-fs-"));
    tempDirs.push(dir);
    return dir;
  }

  function fileCommand(
    jobId: string,
    artifactId: string,
    text: string,
    extras: { requestId?: string; relativePath?: string } = {},
  ) {
    const bytes = Buffer.from(text, "utf8");
    return {
      requestId: extras.requestId ?? requestId(),
      artifactId,
      jobId,
      hostId: "host_mini",
      relativePath: extras.relativePath ?? "card.md",
      mime: "text/markdown",
      size: bytes.byteLength,
      hash: createHash("sha256").update(bytes).digest("hex"),
      author: { kind: "user" as const, userId: "user_kirill" },
      bytes,
    };
  }

  function storageOf(db: SqlDatabase, ctx: ServiceContext, previewRoot: string, metadata = createArtifactMetadataPort(db, ctx)) {
    return createArtifactStorage({
      metadata,
      files: createLocalHostFilePort("host_mini"),
      previewFiles: createLocalHostFilePort("host_mini"),
      previewRoot,
    });
  }

  it("publishes bytes, restarts SQLite, then opens the original from disk", async () => {
    const opened = openFileDb();
    const canonicalRoot = workspace();
    const previewRoot = workspace();
    const seeded = await seedProject(opened.db, { canonicalRoot });
    const first = storageOf(opened.db, seeded.ctx, previewRoot);
    const command = fileCommand(seeded.job.id, "art_file0001", "# card\n");
    const published = await first.publish(command);
    expect(published.ok).toBe(true);
    if (!published.ok) return;
    opened.close();
    const db = reopen(opened.path);
    try {
      const restarted = storageOf(db, seeded.ctx, previewRoot);
      const openedFile = await restarted.openOriginal(command.artifactId, seeded.job.id, published.value.version);
      expect(openedFile.ok).toBe(true);
      if (!openedFile.ok) return;
      expect(Buffer.from(openedFile.value.bytes).toString("utf8")).toBe("# card\n");
      const onDisk = readFileSync(join(canonicalRoot, originalRelativePath(command.artifactId, published.value.version)));
      expect(onDisk.toString("utf8")).toBe("# card\n");
    } finally {
      db.close();
    }
  });

  it("keeps bytes when metadata commit fails and reconcile after reopen commits them", async () => {
    const opened = openFileDb();
    const canonicalRoot = workspace();
    const previewRoot = workspace();
    const seeded = await seedProject(opened.db, { canonicalRoot });
    const inner = createArtifactMetadataPort(opened.db, seeded.ctx);
    const failing = storageOf(
      opened.db,
      seeded.ctx,
      previewRoot,
      withCommitFailure(inner, { code: "metadata_unavailable", message: "injected" }),
    );
    const command = fileCommand(seeded.job.id, "art_file0002", "# pending\n");
    const published = await failing.publish(command);
    expect(published.ok).toBe(false);
    const physical = join(canonicalRoot, originalRelativePath(command.artifactId, 1));
    expect(readFileSync(physical).toString("utf8")).toBe("# pending\n");
    expect(await inner.getVersion({ artifactId: command.artifactId, jobId: seeded.job.id }, 1)).toBeUndefined();
    const pending = await inner.getIntent(command.requestId);
    expect(pending?.state).toBe("pending");
    opened.close();
    const db = reopen(opened.path);
    try {
      const recovered = storageOf(db, seeded.ctx, previewRoot);
      const reconciled = await recovered.reconcile();
      expect(reconciled.ok).toBe(true);
      if (!reconciled.ok) return;
      expect(reconciled.value).toHaveLength(1);
      const openedFile = await recovered.openOriginal(command.artifactId, seeded.job.id, 1);
      expect(openedFile.ok).toBe(true);
      if (!openedFile.ok) return;
      expect(Buffer.from(openedFile.value.bytes).toString("utf8")).toBe("# pending\n");
    } finally {
      db.close();
    }
  });

  it("assigns different versions and originals for concurrent publishes", async () => {
    const { db, close } = openFileDb();
    try {
      const canonicalRoot = workspace();
      const previewRoot = workspace();
      const seeded = await seedProject(db, { canonicalRoot });
      const storage = storageOf(db, seeded.ctx, previewRoot);
      const first = fileCommand(seeded.job.id, "art_file0003", "# one\n", { relativePath: "one.md" });
      const second = fileCommand(seeded.job.id, "art_file0003", "# two\n", { relativePath: "two.md" });
      const [left, right] = await Promise.all([storage.publish(first), storage.publish(second)]);
      expect(left.ok && right.ok).toBe(true);
      if (!left.ok || !right.ok) return;
      expect(new Set([left.value.version, right.value.version])).toEqual(new Set([1, 2]));
      const diskOne = readFileSync(join(canonicalRoot, originalRelativePath("art_file0003", left.value.version)));
      const diskTwo = readFileSync(join(canonicalRoot, originalRelativePath("art_file0003", right.value.version)));
      expect(new Set([diskOne.toString("utf8"), diskTwo.toString("utf8")])).toEqual(new Set(["# one\n", "# two\n"]));
    } finally {
      close();
    }
  });

  it("rolls back profile and process when a later membership or version write fails", async () => {
    const { db, close } = openFileDb();
    try {
      const seeded = await seedProject(db);
      const reviewer = seeded.store.provisionAgent(
        { actor: { kind: "system" }, allowedBindingIds: [] },
        {
          requestId: requestId(),
          name: "Рецензент",
          state: "active",
          version: {
            version: 1,
            role: "reviewer",
            instructions: "Проверять черновик.",
            providerId: "codex",
            model: "gpt-5.6",
            skillIds: ["skill_6153a163fb7fac8c435f3befc88db8417cd0722ba8fdf5ecc37b2b5069ffc3ff"],
            mcpIds: [],
            policyVersionId: seeded.policy.id,
          },
        },
      );
      if (!reviewer.ok) throw new Error(reviewer.error.message);
      const versionsBefore = (
        db.prepare("SELECT count(*) AS n FROM agency_agent_version WHERE agent_id = ?").get(seeded.agent.id) as { n: number }
      ).n;
      const processesBefore = (
        db.prepare("SELECT count(*) AS n FROM agency_process_version WHERE department_id = ?").get(seeded.department.id) as {
          n: number;
        }
      ).n;
      db.exec(`
        CREATE TRIGGER agency_block_agent_version AFTER INSERT ON agency_agent_version
        BEGIN SELECT RAISE(ABORT, 'blocked agent version'); END;
        CREATE TRIGGER agency_block_membership AFTER INSERT ON agency_membership
        BEGIN SELECT RAISE(ABORT, 'blocked membership'); END;
      `);

      const agentFailed = seeded.store.saveAgentProfile(seeded.ctx, {
        requestId: requestId(),
        expectedRevision: 1,
        agentId: seeded.agent.id,
        name: "Не должно сохраниться",
        state: "paused",
        version: {
          version: 2,
          role: "Сломанная версия",
          instructions: "После insert должен быть rollback.",
          providerId: "codex",
          model: "gpt-5.6",
          skillIds: ["skill_6153a163fb7fac8c435f3befc88db8417cd0722ba8fdf5ecc37b2b5069ffc3ff"],
          mcpIds: [],
          policyVersionId: seeded.policy.id,
        },
      });
      expect(agentFailed).toMatchObject({ ok: false, error: { code: "version_immutable" } });
      expect(seeded.store.getAgent(seeded.agent.id)).toMatchObject({
        name: "Редактор",
        state: "active",
        currentVersionId: seeded.agent.currentVersionId,
        revision: 1,
      });
      expect(
        (db.prepare("SELECT count(*) AS n FROM agency_agent_version WHERE agent_id = ?").get(seeded.agent.id) as { n: number }).n,
      ).toBe(versionsBefore);

      const departmentFailed = seeded.store.saveDepartmentProfile(seeded.ctx, {
        requestId: requestId(),
        expectedRevision: 1,
        departmentId: seeded.department.id,
        name: "Не должно сохраниться",
        leadAgentId: seeded.agent.id,
        process: {
          instructions: "Новый процесс, который нельзя оставить.",
          acceptance: "Не принимается.",
          reviewPolicy: { required: true },
        },
        memberships: [
          { agentId: seeded.agent.id, role: "lead" },
          { agentId: reviewer.value.agent.id, role: "executor" },
        ],
      });
      expect(departmentFailed).toMatchObject({ ok: false, error: { code: "membership_write_failed" } });
      expect(seeded.store.getDepartment(seeded.department.id)).toMatchObject({
        name: "Редактура",
        processVersionId: seeded.department.processVersionId,
        revision: 1,
      });
      expect(
        (db.prepare("SELECT count(*) AS n FROM agency_process_version WHERE department_id = ?").get(seeded.department.id) as {
          n: number;
        }).n,
      ).toBe(processesBefore);
      expect(seeded.store.listMemberships(seeded.department.id)).toEqual([
        { departmentId: seeded.department.id, agentId: seeded.agent.id, role: "lead" },
      ]);
    } finally {
      close();
    }
  });

  it("conflicts when the same requestId is replayed with a different payload", async () => {
    const { db, close } = openFileDb();
    try {
      const canonicalRoot = workspace();
      const previewRoot = workspace();
      const seeded = await seedProject(db, { canonicalRoot });
      const storage = storageOf(db, seeded.ctx, previewRoot);
      const reused = requestId();
      const first = await storage.publish(fileCommand(seeded.job.id, "art_file0004", "# first\n", {
        requestId: reused,
        relativePath: "first.md",
      }));
      expect(first.ok).toBe(true);
      const replay = await storage.publish(fileCommand(seeded.job.id, "art_file0004", "# first\n", {
        requestId: reused,
        relativePath: "other.md",
      }));
      expect(replay.ok).toBe(false);
      if (!replay.ok) expect(replay.error.code).toBe("request_conflict");
    } finally {
      close();
    }
  });
});
