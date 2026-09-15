import { fail, ok, type DomainResult } from "../../../domain";
import type { HostFilePort } from "../../../host/file-port.js";
import { sha256Hex } from "../context-snapshot/canonical.js";
import type { ProjectRulesInput } from "../context-snapshot/types.js";

export type ProjectRuleTrustedSource = {
  sourceId: string;
  hostId: string;
  canonicalRoot: string;
};

export type ProjectRuleApplicableFile = {
  sourceId: string;
  relativePath: string;
};

export const BINDING_RULE_SOURCE_ID = "binding" as const;

/** Server-supplied. Reader does not harvest markdown links or walk parents. */
export type ProjectRulesContract = {
  applicable: readonly ProjectRuleApplicableFile[];
  trustedSources: readonly ProjectRuleTrustedSource[];
};

export type LiveBindingPin = {
  hostId: string;
  canonicalRoot: string;
};

/**
 * sourceId `binding` must be the live binding host/root.
 * Parent is a different source; it is never a client-supplied replacement for binding.
 */
export function pinBindingRuleSource(
  live: LiveBindingPin,
  trustedSources: readonly ProjectRuleTrustedSource[],
): DomainResult<true> {
  const bindingSources = trustedSources.filter((source) => source.sourceId === BINDING_RULE_SOURCE_ID);
  if (bindingSources.length === 0) {
    return fail("project_rules_binding_source_missing", "trustedSources must include sourceId binding");
  }
  if (bindingSources.length > 1) {
    return fail("project_rules_source_collision", "trustedSources has more than one binding source");
  }
  const bindingSource = bindingSources[0]!;
  if (bindingSource.hostId !== live.hostId || bindingSource.canonicalRoot !== live.canonicalRoot) {
    return fail(
      "project_rules_binding_source_mismatch",
      "sourceId binding host/root must equal the live ProjectBinding; client root is not accepted",
    );
  }
  return ok(true);
}

export function deriveTrustedSources(
  live: LiveBindingPin,
  parent: ProjectRuleTrustedSource | undefined,
  configuredBindingSource?: ProjectRuleTrustedSource,
): DomainResult<readonly ProjectRuleTrustedSource[]> {
  if (configuredBindingSource) {
    const configured = pinBindingRuleSource(live, [configuredBindingSource]);
    if (!configured.ok) return configured;
  }
  const trusted: ProjectRuleTrustedSource[] = [
    {
      sourceId: BINDING_RULE_SOURCE_ID,
      hostId: live.hostId,
      canonicalRoot: live.canonicalRoot,
    },
  ];
  if (parent) {
    if (parent.sourceId === BINDING_RULE_SOURCE_ID) {
      return fail("project_rules_contract", "parent sourceId must not be binding");
    }
    if (!parent.sourceId.trim() || !parent.hostId.trim() || !parent.canonicalRoot.trim()) {
      return fail("project_rules_contract", "parent source needs verified sourceId, hostId and canonicalRoot");
    }
    trusted.push(parent);
  }
  const pinned = pinBindingRuleSource(live, trusted);
  if (!pinned.ok) return pinned;
  return ok(trusted);
}

export type ProjectRulesFilePorts = {
  filesFor(source: ProjectRuleTrustedSource): DomainResult<HostFilePort>;
};

export type LoadedProjectRuleRead = {
  sourceId: string;
  relativePath: string;
  hostId: string;
  canonicalRoot: string;
};

export type LoadedProjectRules = ProjectRulesInput & {
  reads: readonly LoadedProjectRuleRead[];
};

function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder("utf-8").decode(bytes);
}

function isSafeRelative(path: string): boolean {
  if (!path || path.startsWith("/") || path.includes("\\") || path.includes("\0")) return false;
  const parts = path.split("/");
  return parts.every((part) => part !== "" && part !== "." && part !== "..");
}

function assembleRulesText(files: readonly { label: string; text: string }[]): string {
  return files.map((file) => `<<< ${file.label}\n${file.text}`).join("\n");
}

export function bindingHostFilePorts(files: HostFilePort): ProjectRulesFilePorts {
  return {
    filesFor(source) {
      if (files.hostId !== source.hostId) {
        return fail(
          "host_adapter_mismatch",
          `adapter ${files.hostId} cannot read trusted source ${source.sourceId} host ${source.hostId}`,
        );
      }
      return ok(files);
    },
  };
}

function indexTrustedSources(
  sources: readonly ProjectRuleTrustedSource[],
): DomainResult<Map<string, ProjectRuleTrustedSource>> {
  const index = new Map<string, ProjectRuleTrustedSource>();
  for (const source of sources) {
    if (!source.sourceId.trim() || !source.hostId.trim() || !source.canonicalRoot.trim()) {
      return fail("project_rules_contract", "trustedSources entries need sourceId, hostId and canonicalRoot");
    }
    const existing = index.get(source.sourceId);
    if (existing) {
      if (existing.hostId !== source.hostId || existing.canonicalRoot !== source.canonicalRoot) {
        return fail(
          "project_rules_source_collision",
          `trusted source ${source.sourceId} maps to more than one host/root`,
        );
      }
      continue;
    }
    index.set(source.sourceId, source);
  }
  return ok(index);
}

export async function readProjectRules(
  ports: ProjectRulesFilePorts,
  contract: ProjectRulesContract,
): Promise<DomainResult<LoadedProjectRules>> {
  if (!contract.applicable || contract.applicable.length === 0) {
    return fail("project_rules_missing", "projectRules.applicable is empty; no empty-rules fallback");
  }
  const sources = indexTrustedSources(contract.trustedSources);
  if (!sources.ok) return sources;

  const seen = new Set<string>();
  const loaded: { label: string; text: string; read: LoadedProjectRuleRead }[] = [];
  for (const item of contract.applicable) {
    if (!isSafeRelative(item.relativePath)) {
      return fail(
        "project_rules_path_escape",
        `applicable path must be relative inside its trusted root (no ..): ${item.relativePath}`,
      );
    }
    const source = sources.value.get(item.sourceId);
    if (!source) {
      return fail(
        "project_rules_untrusted_source",
        `applicable source ${item.sourceId} is not in trustedSources; parent outside binding needs its own trusted source`,
      );
    }
    const key = `${source.sourceId}\0${item.relativePath}`;
    if (seen.has(key)) {
      return fail("project_rules_contract", `applicable path listed more than once: ${item.sourceId}:${item.relativePath}`);
    }
    seen.add(key);
    const files = ports.filesFor(source);
    if (!files.ok) return files;
    if (files.value.hostId !== source.hostId) {
      return fail(
        "host_adapter_mismatch",
        `file port host ${files.value.hostId} does not match trusted source ${source.sourceId} host ${source.hostId}`,
      );
    }
    const read = await files.value.read(source.canonicalRoot, item.relativePath);
    if (!read.ok) {
      return fail(
        "project_rules_missing",
        `applicable ${item.sourceId}:${item.relativePath} is missing; no empty fallback`,
      );
    }
    const label = `${item.sourceId}:${item.relativePath}`;
    loaded.push({
      label,
      text: decodeUtf8(read.value),
      read: {
        sourceId: source.sourceId,
        relativePath: item.relativePath,
        hostId: source.hostId,
        canonicalRoot: source.canonicalRoot,
      },
    });
  }

  const text = assembleRulesText(loaded.map((file) => ({ label: file.label, text: file.text })));
  const hash = sha256Hex(text);
  const versionId = `rul_${sha256Hex(`${JSON.stringify(loaded.map((f) => f.read))}\0${hash}`).slice(0, 32)}`;
  return ok({
    versionId,
    text,
    hash,
    reads: loaded.map((file) => file.read),
  });
}
