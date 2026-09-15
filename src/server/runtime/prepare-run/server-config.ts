import type { ExplicitCatalogRoles } from "./catalog-roles.js";
import type { ProjectRuleApplicableFile, ProjectRuleTrustedSource } from "./project-rules.js";

/**
 * Verified server configuration. Not public RPC/CLI input.
 * Does not invent a registry policy row: the running server supplies this.
 */
export type VerifiedPrepareConfig = {
  applicable: readonly ProjectRuleApplicableFile[];
  catalogRoles: ExplicitCatalogRoles;
  /** Explicit server-verified parent. Not a client canonicalRoot. */
  parent?: ProjectRuleTrustedSource;
  /**
   * Optional server-held binding pin. If present it must equal the live binding.
   * Used to reject a mismatched configured source before wiring.
   */
  bindingSource?: ProjectRuleTrustedSource;
};
