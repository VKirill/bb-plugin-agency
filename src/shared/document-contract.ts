import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { hostFileOpInput, hostFileOpOutput } from "../host/file-contract";

export const documentInput = z
  .object({
    sessionId: z.string().uuid(),
    jobId: z.string().regex(/^AG-\d+$/),
    fileId: z.string().min(1).max(128),
    name: z
      .string()
      .min(1)
      .max(180)
      .regex(/^[^/\\\x00-\x1f]+$/)
      .refine((s) => s !== "." && s !== ".."),
    content: z.string().max(7 * 1024 * 1024),
    kind: z.enum(["text", "image"]),
  })
  .strict();

/**
 * Singular bb.host contract. `fileOp` is the artifact jail; `materialize`
 * keeps the existing preview copy. Payload `canonicalRoot` is a jail, not a
 * grant — the Agency server must pass a verified ProjectBinding root.
 */
export const documentHostContract = defineRpcContract({
  materialize: { input: documentInput, output: z.object({ path: z.string() }) },
  fileOp: { input: hostFileOpInput, output: hostFileOpOutput },
});
