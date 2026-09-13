import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { notificationSchema, receiptSchema, statusSchema } from "./schemas";

export const rpcContract = defineRpcContract({
  uiContext: { input: z.null(), output: z.object({ hosts: z.array(z.object({ id: z.string(), name: z.string() })) }) },
  status: { input: z.null(), output: statusSchema },
  notify: { input: notificationSchema, output: receiptSchema },
});
