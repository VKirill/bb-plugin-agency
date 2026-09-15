import { secretRefSchema } from "../../../shared/contracts/versions.js";
import { canonicalizeJson, sha256Hex } from "./canonical.js";
import type { EffectivePolicy, PolicyContent } from "./types.js";

export type PolicyFail = { ok: false; error: { code: string; message: string } };

function fail(code: string, message: string): PolicyFail {
  return { ok: false, error: { code, message } };
}

export function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

export function policyContentHash(content: PolicyContent): string {
  return sha256Hex(
    canonicalizeJson({
      allowedCapabilities: sortedUnique(content.allowedCapabilities),
      cliHostConstraints: {
        providerIds: sortedUnique(content.cliHostConstraints.providerIds),
        hostIds: sortedUnique(content.cliHostConstraints.hostIds),
      },
      secretRefs: sortedUnique(content.secretRefs),
    }),
  );
}

export function requirePolicyArrays(label: string, policy: PolicyContent): PolicyFail | undefined {
  if (!Array.isArray(policy.allowedCapabilities)) {
    return fail("policy_content_required", `${label} allowedCapabilities is required`);
  }
  if (!policy.cliHostConstraints || !Array.isArray(policy.cliHostConstraints.providerIds) || !Array.isArray(policy.cliHostConstraints.hostIds)) {
    return fail("policy_content_required", `${label} cliHostConstraints arrays are required`);
  }
  if (!Array.isArray(policy.secretRefs)) {
    return fail("policy_content_required", `${label} secretRefs is required`);
  }
  return undefined;
}

/** Validates secretRef *name shape* (`[A-Z][A-Z0-9_]{0,79}`). Does not detect secret values. */
export function requireSecretRefNames(label: string, secretRefs: readonly string[]): PolicyFail | undefined {
  for (let index = 0; index < secretRefs.length; index += 1) {
    if (!secretRefSchema.safeParse(secretRefs[index]).success) {
      return fail(
        "secret_ref_name_invalid",
        `${label} secretRefs[${index}] is not a valid name; the entry is omitted from this error`,
      );
    }
  }
  return undefined;
}

/**
 * Two non-empty lists: intersection. Empty intersection is a closed fail,
 * not an unrestricted empty allowlist.
 * One empty list does not narrow the other.
 * Both empty → unrestricted empty list.
 */
export function intersectConstraints(
  left: readonly string[],
  right: readonly string[],
  code: "provider_constraint_mismatch" | "host_constraint_mismatch",
  label: string,
): { ok: true; value: string[] } | PolicyFail {
  const a = sortedUnique(left);
  const b = sortedUnique(right);
  if (a.length === 0) return { ok: true, value: b };
  if (b.length === 0) return { ok: true, value: a };
  const intersection = a.filter((item) => b.includes(item));
  if (intersection.length === 0) {
    return fail(code, `${label} constraint lists are non-empty and disjoint; empty intersection is deny, not unrestricted`);
  }
  return { ok: true, value: intersection };
}

export function intersectCapabilities(left: readonly string[], right: readonly string[]): { ok: true; value: string[] } | PolicyFail {
  const intersection = sortedUnique(left).filter((item) => right.includes(item));
  if (intersection.length === 0) {
    return fail("policy_effective_empty", "binding∩agent allowedCapabilities is empty; empty allowlist denies launch");
  }
  return { ok: true, value: intersection };
}

/**
 * secretRefs are named access grants. Effective grants = intersection.
 * Two non-empty disjoint grant lists fail. Empty on one side yields no grants
 * (not unrestricted access). Dependencies are the union of names and are not grants.
 */
export function splitSecretRefs(
  left: readonly string[],
  right: readonly string[],
): { ok: true; grants: string[]; dependencies: string[] } | PolicyFail {
  const a = sortedUnique(left);
  const b = sortedUnique(right);
  const dependencies = sortedUnique([...a, ...b]);
  if (a.length > 0 && b.length > 0) {
    const grants = a.filter((item) => b.includes(item));
    if (grants.length === 0) {
      return fail("secret_grant_mismatch", "non-empty secretRefs lists are disjoint; intersection is deny, not a union grant");
    }
    return { ok: true, grants, dependencies };
  }
  if (a.length === 0 || b.length === 0) {
    return { ok: true, grants: [], dependencies };
  }
  return { ok: true, grants: a.filter((item) => b.includes(item)), dependencies };
}

export function effectivePolicy(binding: PolicyContent, agent: PolicyContent): { ok: true; value: EffectivePolicy } | PolicyFail {
  const required =
    requirePolicyArrays("bindingPolicyVersion", binding) ?? requirePolicyArrays("agentPolicyVersion", agent);
  if (required) return required;
  const secretNames =
    requireSecretRefNames("bindingPolicyVersion", binding.secretRefs) ??
    requireSecretRefNames("agentPolicyVersion", agent.secretRefs);
  if (secretNames) return secretNames;

  const capabilities = intersectCapabilities(binding.allowedCapabilities, agent.allowedCapabilities);
  if (!capabilities.ok) return capabilities;
  const providers = intersectConstraints(
    binding.cliHostConstraints.providerIds,
    agent.cliHostConstraints.providerIds,
    "provider_constraint_mismatch",
    "providerIds",
  );
  if (!providers.ok) return providers;
  const hosts = intersectConstraints(
    binding.cliHostConstraints.hostIds,
    agent.cliHostConstraints.hostIds,
    "host_constraint_mismatch",
    "hostIds",
  );
  if (!hosts.ok) return hosts;
  const secrets = splitSecretRefs(binding.secretRefs, agent.secretRefs);
  if (!secrets.ok) return secrets;

  const effective: EffectivePolicy = {
    allowedCapabilities: capabilities.value,
    cliHostConstraints: {
      providerIds: providers.value,
      hostIds: hosts.value,
    },
    secretGrants: secrets.grants,
    secretDependencies: secrets.dependencies,
    contentHash: "",
  };
  effective.contentHash = sha256Hex(
    canonicalizeJson({
      allowedCapabilities: effective.allowedCapabilities,
      cliHostConstraints: effective.cliHostConstraints,
      secretGrants: effective.secretGrants,
      secretDependencies: effective.secretDependencies,
    }),
  );
  return { ok: true, value: effective };
}
