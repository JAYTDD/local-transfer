import { z } from 'zod';

const protocolSchema = z.enum(['openai', 'responses', 'anthropic']);

const modelsSchema = z
  .array(z.string().trim().min(1).max(300))
  .max(500)
  .transform((models) => [...new Set(models)]);

export const channelInputSchema = z.object({
  name: z.string().trim().min(1).max(100),
  protocol: protocolSchema,
  baseUrl: z.string().trim().url().transform((value) => value.replace(/\/+$/, '')),
  apiKey: z.string().trim().min(1).optional(),
  defaultMaxTokens: z.number().int().positive().default(4096),
  enabled: z.boolean().default(true),
  models: modelsSchema.default([]),
  modelMap: z.record(z.string(), z.string()).optional(),
  extraApiKeys: z.array(z.string().trim().min(1)).max(20).optional(),
});

export const channelPatchSchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    protocol: protocolSchema.optional(),
    baseUrl: z.string().trim().url().transform((value) => value.replace(/\/+$/, '')).optional(),
    apiKey: z.string().trim().min(1).optional(),
    defaultMaxTokens: z.number().int().positive().optional(),
    enabled: z.boolean().optional(),
    models: modelsSchema.optional(),
    modelMap: z.record(z.string(), z.string()).optional(),
    extraApiKeys: z.array(z.string().trim().min(1)).max(20).optional(),
  })
  .strict();

export const channelOrderSchema = z.object({
  ids: z.array(z.string().uuid()),
});

export const channelTestSchema = z.object({
  model: z.string().trim().min(1).max(300).optional(),
});

export const pullModelsSchema = z.object({
  id: z.string().uuid().optional(),
  protocol: protocolSchema,
  baseUrl: z.string().trim().url().transform((value) => value.replace(/\/+$/, '')),
  apiKey: z.string().trim().optional(),
});

export const settingsInputSchema = z
  .object({
    gatewayToken: z.string().trim().min(1).optional(),
    connectTimeoutMs: z.number().int().min(100).max(300_000).optional(),
    streamIdleTimeoutMs: z.number().int().min(100).max(3_600_000).optional(),
    logRetentionDays: z.number().int().min(0).max(3650).optional(),
    launchAtLogin: z.boolean().optional(),
  })
  .strict();

export const usageQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(2000).default(200),
  offset: z.coerce.number().int().min(0).default(0),
  channelId: z.string().trim().optional(),
  from: z.coerce.number().int().optional(),
  to: z.coerce.number().int().optional(),
});

export const logQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(2000).default(500),
  offset: z.coerce.number().int().min(0).default(0),
  model: z.string().trim().optional(),
  channelId: z.string().trim().optional(),
  status: z.string().trim().optional(),
  stream: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => (value === undefined ? undefined : value === 'true')),
  from: z.coerce.number().int().optional(),
  to: z.coerce.number().int().optional(),
});

/** 订阅中转（relay）模块的开关；两项都可缺省，缺省即不动 */
export const relaySettingsInputSchema = z
  .object({
    enabled: z.boolean().optional(),
    channels: z
      .object({
        trae: z.boolean().optional(),
        workbuddy: z.boolean().optional(),
        qoder: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export function formatZodError(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`).join('; ');
}
