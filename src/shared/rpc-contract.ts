import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { notificationSchema, receiptSchema, statusSchema } from "./schemas";

import { machineSchema, machineInventorySchema, cliPolicySchema } from "./machine-contract";

import { telegramInfoSchema, telegramPreferenceSchema } from "./telegram-contract";

export const rpcContract = defineRpcContract({
  telegramInfo:{input:z.null(),output:telegramInfoSchema},
  telegramPreferences:{input:z.null(),output:telegramPreferenceSchema},
  configureTelegram:{input:telegramPreferenceSchema,output:z.object({saved:z.literal(true)})},
  machines: { input:z.null(), output:z.array(machineSchema) },
  machineInventory: { input:z.object({hostId:z.string().min(1)}).strict(), output:machineInventorySchema },
  setCliPolicy: { input:z.object({hostId:z.string().min(1),providerId:z.string().min(1),policy:cliPolicySchema}).strict(), output:z.object({saved:z.literal(true)}) },
  uiContext: { input: z.null(), output: z.object({ hosts: z.array(z.object({ id: z.string(), name: z.string() })) }) },
  status: { input: z.null(), output: statusSchema },
  notify: { input: notificationSchema, output: receiptSchema },
});
