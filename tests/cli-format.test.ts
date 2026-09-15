import { describe, expect, it } from "vitest";
import { cliFailure, encodeCliJson, redactCliValue } from "../src/server/cli/format";
import { runAgencyCli } from "../src/server/cli/run";

const FORMER_STDOUT_CAP = 32_768;

function oversizedWorkspaceEnvelope() {
  return {
    ok: true as const,
    value: {
      contractVersion: "agency.domain.stage1.v1",
      isolation: {
        catalogSkillsIsolated: false,
        catalogMcpIsolated: false,
        execution: "unavailable",
        reason: "closed",
      },
      bindings: [{
        id: "bnd_aaaaaaaaaaaaaaaaaaaaaaaa",
        bbProjectId: "proj_workspace01",
        bbProjectName: "BB-сервис",
        environmentName: "локально",
        hostName: "Mac mini",
      }],
      jobs: [{
        id: "job_aaaaaaaaaaaaaaaaaaaaaaaa",
        key: "AG-32768",
        title: "listWorkspace CLI JSON",
        description: "payload-pad:".concat("W".repeat(40_000)),
        bytesBase64: "QUFBQQ==",
        secret: "must-not-print",
      }],
      counts: { running: 1 },
      agents: [],
      departments: [],
      memberships: [],
      agentVersions: [],
      processVersions: [],
      projectDepartments: [],
      policies: [],
    },
  };
}

describe("encodeCliJson", () => {
  it("roundtrips a workspace snapshot larger than 32KiB as one JSON value", () => {
    const envelope = oversizedWorkspaceEnvelope();
    const stdout = encodeCliJson(envelope);
    expect(stdout.length).toBeGreaterThan(FORMER_STDOUT_CAP);
    expect(stdout).not.toContain('"truncated"');
    const parsed = JSON.parse(stdout) as typeof envelope;
    expect(parsed.ok).toBe(true);
    expect(parsed.value.jobs).toHaveLength(1);
    expect(parsed.value.jobs[0]?.key).toBe("AG-32768");
    expect(parsed.value.jobs[0]?.description).toBe(envelope.value.jobs[0]?.description);
    expect(parsed.value.jobs[0]?.bytesBase64).toEqual({ omitted: true, reason: "bounded-cli" });
    expect(parsed.value.jobs[0]?.secret).toEqual({ omitted: true, reason: "bounded-cli" });
    expect(parsed.value.bindings[0]?.bbProjectId).toBe("proj_workspace01");
  });

  it("keeps redaction of bytes and secrets on the same encoder", () => {
    expect(redactCliValue({
      bytesBase64: "AAAA",
      secretRefs: ["OPENAI_API_KEY"],
      nested: { token: "t", logBytes: "xx" },
    })).toEqual({
      bytesBase64: { omitted: true, reason: "bounded-cli" },
      secretRefs: ["OPENAI_API_KEY"],
      nested: {
        token: { omitted: true, reason: "bounded-cli" },
        logBytes: { omitted: true, reason: "bounded-cli" },
      },
    });
  });

  it("encodes cliFailure as complete JSON, not an empty success", () => {
    const failed = cliFailure("cli_output_invalid", "machine JSON must stay complete");
    expect(failed.exitCode).toBe(1);
    expect(failed.stdout.trim()).not.toBe("");
    const parsed = JSON.parse(failed.stdout) as { ok: false; error: { code: string } };
    expect(parsed).toEqual({
      ok: false,
      error: { code: "cli_output_invalid", message: "machine JSON must stay complete" },
    });
  });
});

describe("CLI listWorkspace stdout", () => {
  it("returns full parseable workspace JSON over 32KiB without silent empty success", async () => {
    const envelope = oversizedWorkspaceEnvelope();
    const result = await runAgencyCli({
      status: () => ({
        phase: "runtime",
        execution: "requires_readiness",
        reason: "status does not grant launch",
        inboxCount: 0,
      }),
      notify: () => {
        throw new Error("notify unused");
      },
      dispatch: async (operation) => {
        expect(operation).toBe("listWorkspace");
        return envelope;
      },
    }, ["workspace"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.length).toBeGreaterThan(FORMER_STDOUT_CAP);
    expect(result.stdout.trim()).not.toBe("");
    expect(result.stdout).not.toContain('"truncated"');
    const parsed = JSON.parse(result.stdout) as typeof envelope;
    expect(parsed.ok).toBe(true);
    expect(parsed.value.jobs[0]?.description?.length).toBeGreaterThan(FORMER_STDOUT_CAP);
    expect(parsed.value.jobs[0]?.bytesBase64).toEqual({ omitted: true, reason: "bounded-cli" });
  });
});
