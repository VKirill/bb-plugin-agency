import { mkdtemp, readFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import type { ExperimentalHostRpcContext } from "@get-bb/plugin-sdk";
import { readFileSync } from "node:fs";
import { documentHostContract, documentInput } from "../src/shared/document-contract";
import { rpcContract } from "../src/shared/rpc-contract";
import { hostEntryHandlers } from "../src/host/entry-handlers";
import { hostFileOpInput } from "../src/host/file-contract";
import {
  callBoundFileOp,
  createSdkHostFilePortFromBinding,
  resolveBoundFileCall,
  resolveBoundFileOp,
} from "../src/host/sdk-file-port";
import { originalRelativePath } from "../src/host/safe-path";

const roots: string[] = [];

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function hostContext(dataDir: string): ExperimentalHostRpcContext {
  const controller = new AbortController();
  return {
    signal: controller.signal,
    lifecycle: { signal: controller.signal },
    experimental_paths: { dataDir, tempDir: dataDir },
    experimental_emitSignal: async () => undefined,
    experimental_watch: async () => ({ dispose: async () => undefined }),
    experimental_retainWorker: () => ({ dispose: async () => undefined }),
  };
}

const previewInput = {
  sessionId: "1a9d18d9-6b40-4dc1-843c-2155b6380971",
  jobId: "AG-102",
  fileId: "preview-1",
  name: "Пример.md",
  kind: "text" as const,
  content: "# Документ",
};

describe("AGY-18 host file wiring", () => {
  it("keeps one host entry with materialize and fileOp", () => {
    expect(Object.keys(documentHostContract).sort()).toEqual(["fileOp", "materialize"]);
    expect(Object.keys(hostEntryHandlers).sort()).toEqual(["fileOp", "materialize"]);
    expect(Object.keys(rpcContract)).not.toContain("fileOp");
    const hostSource = readFileSync(new URL("../host.ts", import.meta.url), "utf8");
    expect(hostSource).toContain("documentHostContract");
    expect(hostSource).toContain("hostEntryHandlers");
    expect(hostSource.match(/experimental_defineHostEntry/g)).toHaveLength(2);
  });

  it("does not call host RPC without a binding or hostId", async () => {
    let calls = 0;
    const client = {
      call: async () => {
        calls += 1;
        throw new Error("host must not be called");
      },
    };
    expect(resolveBoundFileCall(null)).toMatchObject({ ok: false, error: { code: "binding_missing" } });
    expect(resolveBoundFileCall(undefined)).toMatchObject({ ok: false, error: { code: "binding_missing" } });
    expect(resolveBoundFileCall({ hostId: "   ", canonicalRoot: "/tmp/root" })).toMatchObject({
      ok: false,
      error: { code: "binding_host_missing" },
    });
    expect(await callBoundFileOp(client, null, { op: "stat", relativePath: "a.md" })).toMatchObject({
      ok: false,
      error: { code: "binding_missing" },
    });
    expect(await callBoundFileOp(client, { hostId: "", canonicalRoot: "/tmp/root" }, { op: "stat", relativePath: "a.md" }))
      .toMatchObject({ ok: false, error: { code: "binding_host_missing" } });
    expect(createSdkHostFilePortFromBinding(client, null)).toMatchObject({
      ok: false,
      error: { code: "binding_missing" },
    });
    expect(calls).toBe(0);
  });

  it("uses binding hostId, not a primary host", async () => {
    const calls: Array<{ hostId: string; root: string }> = [];
    const client = {
      call: async (_method: "fileOp", input: { canonicalRoot: string }, options: { hostId: string }) => {
        calls.push({ hostId: options.hostId, root: input.canonicalRoot });
        return { ok: true as const, missing: true };
      },
    };
    const binding = { hostId: "host_order", canonicalRoot: "/tmp/order-root" };
    const result = await callBoundFileOp(client, binding, { op: "stat", relativePath: "briefs/offer.md" });
    expect(result).toMatchObject({ ok: true, value: { missing: true } });
    expect(calls).toEqual([{ hostId: "host_order", root: "/tmp/order-root" }]);
    expect(calls[0]?.hostId).not.toBe("host_primary");
  });

  it("rejects a payload root that tries to replace the binding root", async () => {
    let calls = 0;
    const client = {
      call: async () => {
        calls += 1;
        return { ok: true as const, missing: true };
      },
    };
    const binding = { hostId: "host_order", canonicalRoot: "/tmp/trusted" };
    expect(resolveBoundFileOp(binding, {
      op: "stat",
      relativePath: "briefs/offer.md",
      canonicalRoot: "/tmp/attacker",
    })).toMatchObject({ ok: false, error: { code: "untrusted_root" } });
    expect(await callBoundFileOp(client, binding, {
      op: "stat",
      relativePath: "briefs/offer.md",
      canonicalRoot: "/tmp/attacker",
    })).toMatchObject({ ok: false, error: { code: "untrusted_root" } });
    expect(calls).toBe(0);
  });

  it("materialize still writes a preview under plugin dataDir", async () => {
    const dataDir = await tempDir("agy18-preview-");
    const parsed = documentInput.parse(previewInput);
    const result = await hostEntryHandlers.materialize(parsed, hostContext(dataDir));
    expect(result.path.startsWith(dataDir)).toBe(true);
    expect(await readFile(result.path, "utf8")).toBe("# Документ");
  });

  it("fileOp handler jails to the supplied root and rejects escape", async () => {
    const jail = await tempDir("agy18-jail-");
    const outside = await tempDir("agy18-out-");
    await symlink(outside, join(jail, "leak"));
    const bytes = Buffer.from("secret-body", "utf8");
    const ctx = hostContext(jail);
    const written = await hostEntryHandlers.fileOp({
      op: "writeAtomic",
      canonicalRoot: jail,
      relativePath: originalRelativePath("art_brief001", 1),
      bytesBase64: bytes.toString("base64"),
    }, ctx);
    expect(written).toMatchObject({ ok: true, size: bytes.byteLength });
    if (!written.ok) return;
    expect(await readFile(join(jail, originalRelativePath("art_brief001", 1)))).toEqual(bytes);

    const escaped = await hostEntryHandlers.fileOp({
      op: "writeAtomic",
      canonicalRoot: jail,
      relativePath: "leak/secret.md",
      bytesBase64: bytes.toString("base64"),
    }, ctx);
    expect(escaped).toMatchObject({ ok: false, code: "path_escape" });
    await expect(readFile(join(outside, "secret.md"))).rejects.toMatchObject({ code: "ENOENT" });

    const missingBytes = await hostEntryHandlers.fileOp({
      op: "writeAtomic",
      canonicalRoot: jail,
      relativePath: "briefs/offer.md",
    }, ctx);
    expect(missingBytes).toMatchObject({ ok: false, code: "invalid_file_op" });

    const missingRoot = await hostEntryHandlers.fileOp({
      op: "stat",
      canonicalRoot: join(jail, "no-such-root"),
      relativePath: "briefs/offer.md",
    }, ctx);
    expect(missingRoot).toMatchObject({ ok: false, code: "binding_root_missing" });
  });

  it("handler has no host ACL: any existing root is a jail (limitation)", async () => {
    const unlisted = await tempDir("agy18-unlisted-");
    const written = await hostEntryHandlers.fileOp({
      op: "writeAtomic",
      canonicalRoot: unlisted,
      relativePath: "untrusted/note.md",
      bytesBase64: Buffer.from("x").toString("base64"),
    }, hostContext(unlisted));
    expect(written.ok).toBe(true);
    expect(await readFile(join(unlisted, "untrusted/note.md"), "utf8")).toBe("x");
  });

  it("SDK client uses callBoundFileOp with the binding host", async () => {
    const jail = await tempDir("agy18-sdk-");
    const calls: Array<{ method: string; hostId: string; root: string }> = [];
    const { bb, harness } = createFakePluginHost({
      experimental_callHostRpc: async (call) => {
        const parsed = hostFileOpInput.parse(call.input);
        calls.push({ method: call.method, hostId: call.hostId, root: parsed.canonicalRoot });
        return hostEntryHandlers.fileOp(parsed, hostContext(jail));
      },
    });
    try {
      const client = bb.hosts.experimental_client({ contract: documentHostContract });
      const binding = { hostId: "host_order", canonicalRoot: jail };
      const bytes = Buffer.from("from-sdk", "utf8");
      const written = await callBoundFileOp(client, binding, {
        op: "writeAtomic",
        relativePath: "briefs/offer.md",
        bytesBase64: bytes.toString("base64"),
      });
      expect(written).toMatchObject({ ok: true, value: { size: bytes.byteLength } });
      expect(await readFile(join(jail, "briefs/offer.md"))).toEqual(bytes);
      expect(calls).toEqual([{ method: "fileOp", hostId: "host_order", root: jail }]);
      expect(harness.inspection.experimental_hostRpcCalls).toHaveLength(1);

      const escaped = await callBoundFileOp(client, binding, {
        op: "writeAtomic",
        relativePath: "../outside.md",
        bytesBase64: bytes.toString("base64"),
      });
      expect(escaped).toMatchObject({ ok: false, error: { code: "path_escape" } });
    } finally {
      await harness.lifecycle.dispose();
    }
  });
});
