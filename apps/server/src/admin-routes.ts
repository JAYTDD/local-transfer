import type { FastifyInstance } from 'fastify';

import type { SettingsDto } from '@aihub/shared';

import { Repository } from './db.js';
import { channelToDto, logsToDto } from './dto.js';
import { AdminRequestError, sendAdminError } from './errors.js';
import { pullUpstreamModels, testUpstreamChannel } from './upstream.js';
import {
  channelInputSchema,
  channelOrderSchema,
  channelPatchSchema,
  channelTestSchema,
  formatZodError,
  logQuerySchema,
  pullModelsSchema,
  settingsInputSchema,
} from './validation.js';

function parseOrThrow<T>(schema: { safeParse(input: unknown): { success: true; data: T } | { success: false; error: Parameters<typeof formatZodError>[0] } }, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new AdminRequestError(400, formatZodError(result.error), 'validation_error');
  return result.data;
}

export async function registerAdminRoutes(app: FastifyInstance, repository: Repository): Promise<void> {
  app.get('/api/admin/session', async () => ({ ok: true, authRequired: false }));

  app.get('/api/admin/channels', async () => ({
    data: repository.listChannels().map(channelToDto),
  }));

  app.post('/api/admin/channels', async (request, reply) => {
    try {
      const input = parseOrThrow(channelInputSchema, request.body);
      if (!input.apiKey) throw new AdminRequestError(400, 'apiKey is required', 'validation_error');
      const channel = repository.createChannel({
        name: input.name,
        protocol: input.protocol,
        baseUrl: input.baseUrl,
        apiKey: input.apiKey,
        defaultMaxTokens: input.defaultMaxTokens,
        enabled: input.enabled,
        models: input.models,
      });
      reply.code(201);
      return { data: channelToDto(channel) };
    } catch (error) {
      sendAdminError(reply, error);
    }
  });

  app.put('/api/admin/channels/order', async (request, reply) => {
    try {
      const input = parseOrThrow(channelOrderSchema, request.body);
      if (!repository.reorderChannels(input.ids)) {
        throw new AdminRequestError(400, 'ids must contain every channel exactly once', 'validation_error');
      }
      return { data: repository.listChannels().map(channelToDto) };
    } catch (error) {
      sendAdminError(reply, error);
    }
  });

  app.put('/api/admin/channels/:id', async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const input = parseOrThrow(channelInputSchema, request.body);
      const existing = repository.getChannel(id);
      if (!existing) throw new AdminRequestError(404, 'Channel not found', 'not_found');
      const channel = repository.updateChannel(id, {
        name: input.name,
        protocol: input.protocol,
        baseUrl: input.baseUrl,
        apiKey: input.apiKey ?? existing.apiKey,
        defaultMaxTokens: input.defaultMaxTokens,
        enabled: input.enabled,
        models: input.models,
      });
      return { data: channelToDto(channel!) };
    } catch (error) {
      sendAdminError(reply, error);
    }
  });

  app.patch('/api/admin/channels/:id', async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const input = parseOrThrow(channelPatchSchema, request.body);
      const channel = repository.updateChannel(id, input);
      if (!channel) throw new AdminRequestError(404, 'Channel not found', 'not_found');
      return { data: channelToDto(channel) };
    } catch (error) {
      sendAdminError(reply, error);
    }
  });

  app.delete('/api/admin/channels/:id', async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      if (!repository.deleteChannel(id)) throw new AdminRequestError(404, 'Channel not found', 'not_found');
      return { ok: true };
    } catch (error) {
      sendAdminError(reply, error);
    }
  });

  app.post('/api/admin/channels/:id/duplicate', async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const channel = repository.duplicateChannel(id);
      if (!channel) throw new AdminRequestError(404, 'Channel not found', 'not_found');
      reply.code(201);
      return { data: channelToDto(channel) };
    } catch (error) {
      sendAdminError(reply, error);
    }
  });

  app.post('/api/admin/channels/:id/test', async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const channel = repository.getChannel(id);
      if (!channel) throw new AdminRequestError(404, 'Channel not found', 'not_found');
      const input = parseOrThrow(channelTestSchema, request.body ?? {});
      const model = input.model ?? channel.models[0];
      if (!model) throw new AdminRequestError(400, 'Channel has no model to test', 'validation_error');
      const settings = repository.getSettings();
      const result = await testUpstreamChannel(channel, model, settings.connectTimeoutMs);
      return { data: result };
    } catch (error) {
      sendAdminError(reply, error);
    }
  });

  app.post('/api/admin/channels/pull-models', async (request, reply) => {
    try {
      const input = parseOrThrow(pullModelsSchema, request.body);
      const stored = input.id ? repository.getChannel(input.id) : null;
      if (input.id && !stored) throw new AdminRequestError(404, 'Channel not found', 'not_found');
      const apiKey = input.apiKey || stored?.apiKey;
      if (!apiKey) throw new AdminRequestError(400, 'apiKey is required', 'validation_error');
      const settings = repository.getSettings();
      const result = await pullUpstreamModels(
        {
          protocol: input.protocol,
          baseUrl: input.baseUrl,
          apiKey,
        },
        settings.connectTimeoutMs,
      );
      return { data: result };
    } catch (error) {
      sendAdminError(reply, error);
    }
  });

  app.get('/api/admin/logs', async (request, reply) => {
    try {
      const query = parseOrThrow(logQuerySchema, request.query);
      return { data: logsToDto(repository, query) };
    } catch (error) {
      sendAdminError(reply, error);
    }
  });

  app.get('/api/admin/settings', async () => {
    const settings = repository.getSettings();
    const dto: SettingsDto = {
      gatewayToken: settings.gatewayToken,
      connectTimeoutMs: settings.connectTimeoutMs,
      streamIdleTimeoutMs: settings.streamIdleTimeoutMs,
    };
    return { data: dto };
  });

  app.put('/api/admin/settings', async (request, reply) => {
    try {
      const input = parseOrThrow(settingsInputSchema, request.body);
      repository.updateSettings(input);
      const settings = repository.getSettings();
      return {
        data: {
          gatewayToken: settings.gatewayToken,
          connectTimeoutMs: settings.connectTimeoutMs,
          streamIdleTimeoutMs: settings.streamIdleTimeoutMs,
        },
      };
    } catch (error) {
      sendAdminError(reply, error);
    }
  });
}
