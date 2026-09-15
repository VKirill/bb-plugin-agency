import { randomBytes } from "node:crypto";
import { opaqueIdSchema, type OpaqueId } from "../../shared/contracts";

export const ID_PREFIX = {
  agent: "agt",
  agentVersion: "avr",
  policy: "pol",
  department: "dep",
  process: "prc",
  binding: "bnd",
  job: "job",
  artifact: "art",
  activity: "act",
  snapshot: "snp",
  runAttempt: "run",
  eventDefinition: "evd",
  eventSource: "evs",
  inboxEvent: "ibe",
  ruleVersion: "rlv",
  ruleMatch: "rlm",
  actionIntent: "ain",
} as const;

export type IdKind = keyof typeof ID_PREFIX;

export function newOpaqueId(kind: IdKind): OpaqueId {
  return opaqueIdSchema.parse(`${ID_PREFIX[kind]}_${randomBytes(12).toString("hex")}`);
}
