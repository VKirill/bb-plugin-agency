import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const hostFileOpInput = z
  .object({
    op: z.enum(["writeAtomic", "read", "stat", "remove"]),
    canonicalRoot: z.string().min(1).max(1024),
    relativePath: z.string().min(1).max(512),
    bytesBase64: z.string().max(8 * 1024 * 1024).optional(),
  })
  .strict();

export const hostFileOpOutput = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    size: z.number().int().nonnegative().optional(),
    hash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    missing: z.boolean().optional(),
    bytesBase64: z.string().optional(),
  }).strict(),
  z.object({
    ok: z.literal(false),
    code: z.string().min(1),
    message: z.string().min(1),
  }).strict(),
]);

/**
 * fileOp schemas only. The live host entry registers them on
 * `documentHostContract` together with `materialize`. Do not add a second
 * host entry. Input root is a server-supplied jail, not a grant of access.
 */
export const hostFileContract = defineRpcContract({
  fileOp: { input: hostFileOpInput, output: hostFileOpOutput },
});

export type HostFileOpInput = z.infer<typeof hostFileOpInput>;
export type HostFileOpOutput = z.infer<typeof hostFileOpOutput>;
