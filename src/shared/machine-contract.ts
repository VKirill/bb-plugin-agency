import { z } from 'zod';
export const cliPolicySchema=z.enum(['enabled','reserve','disabled']);
export const machineSchema=z.object({id:z.string(),name:z.string(),connected:z.boolean(),phase:z.string(),lastSeenAt:z.number().nullable()});
export const machineInventorySchema=z.object({machine:machineSchema,checkedAt:z.string(),error:z.string().nullable(),providers:z.array(z.object({id:z.string(),name:z.string(),available:z.boolean(),installed:z.boolean().nullable(),version:z.string().nullable(),versionUnsupported:z.boolean(),policy:cliPolicySchema}))});
export type MachineInventory=z.infer<typeof machineInventorySchema>;
export type CliPolicy=z.infer<typeof cliPolicySchema>;
