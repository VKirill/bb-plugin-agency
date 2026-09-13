import { z } from 'zod';
export const telegramCapabilitiesSchema=z.object({version:z.literal(1),enabled:z.boolean(),actions:z.array(z.string()),events:z.array(z.string()),destinations:z.array(z.object({projectId:z.string(),name:z.string()}))});
export const telegramInfoSchema=z.object({installed:z.boolean(),running:z.boolean(),compatible:z.boolean(),version:z.string().nullable(),reason:z.string().nullable(),capabilities:telegramCapabilitiesSchema.nullable()});
export const telegramPreferenceSchema=z.object({enabled:z.boolean(),projectId:z.string().max(160),notifications:z.boolean(),questions:z.boolean()}).strict();
export type TelegramInfo=z.infer<typeof telegramInfoSchema>;
export type TelegramPreference=z.infer<typeof telegramPreferenceSchema>;
