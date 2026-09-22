import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { openMigratedDatabase } from "../src/server/db";
import { assertDependenciesDone } from "../src/server/flow/service";
import { assertSpecAccepted } from "../src/server/flow/spec-gate";
import { WAIT_CODES } from "../src/server/runtime/launch-queue/service";
import { rulesForDepartment, workRulesView } from "../src/server/rules/work-rules";
import { createJobCommandSchema, type Job } from "../src/shared/contracts/job";
import { seed } from "./role-types.test";

const HASH_A = "ab".repeat(32);

function setup() {
  const db = openMigratedDatabase(new Database(":memory:"));
  const s = seed(db);
  const productLead = s.store.provisionAgent(s.bootstrap, {
    requestId: randomUUID(),
    name: "Продукт",
    state: "active",
    version: {
      version: 1,
      role: "Руководитель продукта",
      instructions: "Писать спецификации.",
      providerId: "claude-code",
      model: "claude-sonnet-5",
      skillIds: ["skill_6153a163fb7fac8c435f3befc88db8417cd0722ba8fdf5ecc37b2b5069ffc3ff"],
      mcpIds: [],
      policyVersionId: s.policyVersionId,
    },
  });
  if (!productLead.ok) throw new Error(productLead.error.message);
  const specDepartment = s.store.provisionDepartment(s.bootstrap, {
    requestId: randomUUID(),
    name: "Продукт",
    leadAgentId: productLead.value.agent.id,
    process: { instructions: "## Принимаем\n- Спецификации", acceptance: "Версия.", reviewPolicy: { required: true } },
  });
  if (!specDepartment.ok) throw new Error(specDepartment.error.message);
  const specDepartmentId = specDepartment.value.department.id;
  const enableRule = () => {
    const saved = s.store.saveWorkRules(s.bootstrap, {
      requestId: randomUUID(),
      scope: "agency",
      expectedRevision: workRulesView(db, "agency").revision,
      rules: { specDepartmentId, specGatedDepartmentIds: [s.departmentId] },
    });
    if (!saved.ok) throw new Error(saved.error.message);
  };
  const job = (title: string, extra: Record<string, unknown> = {}) => {
    const created = s.store.createJob(
      s.ctx,
      createJobCommandSchema.parse({
        requestId: randomUUID(),
        bindingId: s.ctx.allowedBindingIds[0],
        departmentId: s.departmentId,
        title,
        brief: "Бриф.",
        acceptance: "Критерий.",
        assignedAgentId: extra.departmentId === specDepartmentId ? productLead.value.agent.id : s.developer,
        ...extra,
      }),
    );
    if (!created.ok) throw new Error(created.error.message);
    return created.value;
  };
  const acceptSpec = (specJob: Job, artifactId = "art_specgate01") => {
    db.pragma("foreign_keys = OFF");
    db.prepare(`INSERT INTO agency_artifact (id, job_id) VALUES (?, ?)`).run(artifactId, specJob.id);
    db.prepare(
      `INSERT INTO agency_artifact_acceptance (artifact_id, job_id, version, hash, accepted_at)
       VALUES (?, ?, 1, ?, '2026-09-20T00:00:00.000Z')`,
    ).run(artifactId, specJob.id, HASH_A);
    db.prepare(`UPDATE agency_job SET state = 'done' WHERE id = ?`).run(specJob.id);
    db.pragma("foreign_keys = ON");
    return { artifactId, version: 1, hash: HASH_A };
  };
  const attachInput = (target: Job, source: Job, accepted: { artifactId: string; version: number; hash: string }) => {
    db.pragma("foreign_keys = OFF");
    db.prepare(
      `INSERT INTO agency_job_input_ref (target_job_id, source_job_id, artifact_id, version, hash, host_id, relative_path, accepted, created_at)
       VALUES (?, ?, ?, ?, ?, 'host_mini', 'spec.md', 1, '2026-09-20T00:00:00.000Z')`,
    ).run(target.id, source.id, accepted.artifactId, accepted.version, accepted.hash);
    db.pragma("foreign_keys = ON");
  };
  const launchGate = (item: Job) => {
    const dependencies = assertDependenciesDone(db, item, false);
    if (!dependencies.ok) return dependencies;
    return assertSpecAccepted(db, item, rulesForDepartment(db, item.departmentId), false);
  };
  return { db, s, specDepartmentId, productLeadId: productLead.value.agent.id, enableRule, job, acceptSpec, attachInput, launchGate };
}

describe("spec gate at launch and create", () => {
  it("admits a bounded technical spike before the spec, but not an unbounded or implementation job", () => {
    const { db, job, enableRule, launchGate } = setup();
    enableRule();
    const root = job("Программа", { workKind: "new-program" });
    const contract = { mayChange: ["fixtures/spike/**"], mustNotTouch: ["src/**"], checks: ["node fixtures/spike/check.js"] };
    const spike = job("Проверить SDK", { parentJobId: root.id, workKind: "spike", contract });
    expect(launchGate(spike).ok).toBe(true);
    const discovery = job("Прочитать SDK", { parentJobId: root.id, workKind: "discovery", contract });
    expect(launchGate(discovery).ok).toBe(true);
    expect(launchGate(job("Без границ", { parentJobId: root.id, workKind: "spike" })).ok).toBe(false);
    expect(launchGate(job("Реализация", { parentJobId: root.id, workKind: "feature", contract })).ok).toBe(false);
    db.close();
  });

  it("admits an existing system QC only through its exact source version and the source's normative input", () => {
    const { db, job, enableRule, launchGate, specDepartmentId, acceptSpec, attachInput } = setup();
    enableRule();
    const root = job("Программа", { workKind: "new-program" });
    const spec = job("Спецификация", { parentJobId: root.id, departmentId: specDepartmentId });
    const accepted = acceptSpec(spec);
    const work = job("Код", { parentJobId: root.id });
    attachInput(work, spec, accepted);
    const qc = job("Проверка кода", { parentJobId: root.id });
    const version = { artifactId: "art_workreview01", version: 1, hash: "cd".repeat(32) };
    attachInput(qc, work, version);
    expect(launchGate(qc).ok).toBe(false); // arbitrary input does not confer exemption
    db.prepare(`INSERT INTO agency_auto_review (job_id, hash, review_job_id, outcome, created_at) VALUES (?, ?, ?, 'queued', '2026-09-22T00:00:00.000Z')`).run(work.id, version.hash, qc.id);
    expect(launchGate(qc).ok).toBe(true);
    db.prepare(`UPDATE agency_job_input_ref SET hash = ? WHERE target_job_id = ?`).run("ef".repeat(32), qc.id);
    expect(launchGate(qc).ok).toBe(false);
    db.close();
  });

  it("(а) правило выключено при пустых настройках", () => {
    const { db, s, job, launchGate } = setup();
    const root = job("Программа", { workKind: "new-program" });
    const child = job("Код", { parentJobId: root.id });
    expect(workRulesView(db, "agency").effective.specDepartmentId).toBeNull();
    expect(workRulesView(db, "agency").effective.specGatedDepartmentIds).toEqual([]);
    expect(launchGate(child).ok).toBe(true);
    expect(s.store.listActivity(child.id).some((row) => row.comment?.startsWith("intake_violation=spec-before-code"))).toBe(false);
    db.close();
  });

  it("(б) корень new-program: подзадача отдела из списка без задачи спецификаций → spec_required, ожидает вход в очереди", () => {
    const { db, enableRule, job, launchGate } = setup();
    enableRule();
    const root = job("Программа", { workKind: "new-program" });
    const child = job("Код", { parentJobId: root.id });
    const refused = launchGate(child);
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.code).toBe("spec_required");
    expect(refused.error.message).toContain("no_spec_job");
    expect(WAIT_CODES.has("spec_required")).toBe(true);
    db.close();
  });

  it("(в) задача спецификаций есть, но не done: при зависимости отвечает dependencies_open, без зависимости spec_required", () => {
    const { db, s, specDepartmentId, enableRule, job, launchGate } = setup();
    enableRule();
    const root = job("Программа", { workKind: "new-program" });
    const spec = job("Спецификация", { parentJobId: root.id, departmentId: specDepartmentId });
    const child = job("Код", { parentJobId: root.id });
    const withoutDepend = launchGate(child);
    expect(withoutDepend.ok).toBe(false);
    if (!withoutDepend.ok) {
      expect(withoutDepend.error.code).toBe("spec_required");
      expect(withoutDepend.error.message).toContain("spec_not_accepted");
    }
    const added = s.store.addJobDependency(s.ctx, { requestId: randomUUID(), jobId: child.id, dependsOnJobId: spec.id });
    expect(added.ok).toBe(true);
    const withDepend = launchGate(child);
    expect(withDepend.ok).toBe(false);
    if (!withDepend.ok) expect(withDepend.error.code).toBe("dependencies_open");
    db.close();
  });

  it("(г) done + принятая версия + depend → проходит", () => {
    const { db, s, specDepartmentId, enableRule, job, acceptSpec, launchGate } = setup();
    enableRule();
    const root = job("Программа", { workKind: "new-program" });
    const spec = job("Спецификация", { parentJobId: root.id, departmentId: specDepartmentId });
    acceptSpec(spec);
    const child = job("Код", { parentJobId: root.id });
    const added = s.store.addJobDependency(s.ctx, { requestId: randomUUID(), jobId: child.id, dependsOnJobId: spec.id });
    expect(added.ok).toBe(true);
    expect(launchGate(child).ok).toBe(true);
    db.close();
  });

  it("(д) done + принятая версия приложена входом с тем же hash → проходит", () => {
    const { db, specDepartmentId, enableRule, job, acceptSpec, attachInput, launchGate } = setup();
    enableRule();
    const root = job("Программа", { workKind: "new-program" });
    const spec = job("Спецификация", { parentJobId: root.id, departmentId: specDepartmentId });
    const accepted = acceptSpec(spec);
    const child = job("Код", { parentJobId: root.id });
    attachInput(child, spec, accepted);
    expect(launchGate(child).ok).toBe(true);
    db.close();
  });

  it("(е) корень feature/null → проходит", () => {
    const { db, enableRule, job, launchGate } = setup();
    enableRule();
    const featureRoot = job("Функция", { workKind: "feature" });
    const featureChild = job("Код функции", { parentJobId: featureRoot.id });
    expect(launchGate(featureChild).ok).toBe(true);
    const plainRoot = job("Без вида");
    const plainChild = job("Код без вида", { parentJobId: plainRoot.id });
    expect(launchGate(plainChild).ok).toBe(true);
    db.close();
  });

  it("(ж) создание подзадачи без задачи спецификаций пишет комментарий intake_violation=spec-before-code в обе истории, создание успешно", () => {
    const { db, s, enableRule, job } = setup();
    enableRule();
    const root = job("Программа", { workKind: "new-program" });
    const child = job("Код", { parentJobId: root.id });
    expect(child.id).toBeTruthy();
    const marker = (row: { comment?: string | null }) => row.comment?.startsWith("intake_violation=spec-before-code");
    expect(s.store.listActivity(child.id).some(marker)).toBe(true);
    expect(s.store.listActivity(root.id).some(marker)).toBe(true);
    const note = s.store.listActivity(child.id).find(marker)?.comment ?? "";
    expect(note).toContain(child.key);
    expect(note).toContain("no_spec_job");
    db.close();
  });

  it("(з) при корне bugfix комментария нет", () => {
    const { db, s, enableRule, job } = setup();
    enableRule();
    const root = job("Починка", { workKind: "bugfix" });
    const child = job("Патч", { parentJobId: root.id });
    const marker = (row: { comment?: string | null }) => row.comment?.includes("intake_violation=spec-before-code");
    expect(s.store.listActivity(child.id).some(marker)).toBe(false);
    expect(s.store.listActivity(root.id).some(marker)).toBe(false);
    db.close();
  });
});
