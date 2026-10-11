import type { FastifyInstance } from 'fastify';

import type { RelayChannelToggle, RelayStatusDto, SettingsDto } from '@aihub/shared';

import { Repository } from './db.js';
import { channelToDto, logsToDto } from './dto.js';
import { AdminRequestError, sendAdminError } from './errors.js';
import type { RelayModule } from './relay.js';
import { pullUpstreamModels, testUpstreamChannel } from './upstream.js';
import {
  channelInputSchema,
  channelOrderSchema,
  channelPatchSchema,
  channelTestSchema,
  formatZodError,
  logQuerySchema,
  pullModelsSchema,
  relaySettingsInputSchema,
  settingsInputSchema,
} from './validation.js';

/** relay 模块未接入（或测试里没传）时，按数据库设置给出同一份形状 */
function relayStatus(repository: Repository, relay: RelayModule | null): RelayStatusDto {
  if (relay) return relay.status();
  const settings = repository.getSettings();
  return {
    enabled: settings.relayEnabled,
    channels: settings.relayChannels,
    ready: false,
    prefixes: [],
  };
}

function parseOrThrow<T>(schema: { safeParse(input: unknown): { success: true; data: T } | { success: false; error: Parameters<typeof formatZodError>[0] } }, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new AdminRequestError(400, formatZodError(result.error), 'validation_error');
  return result.data;
}

export async function registerAdminRoutes(
  app: FastifyInstance,
  repository: Repository,
  relay: RelayModule | null = null,
): Promise<void> {
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

  app.get('/api/admin/relay', async () => ({ data: relayStatus(repository, relay) }));

  app.put('/api/admin/relay', async (request, reply) => {
    try {
      const input = parseOrThrow(relaySettingsInputSchema, request.body);
      const patch: { relayEnabled?: boolean; relayChannels?: RelayChannelToggle } = {};
      if (input.enabled !== undefined) patch.relayEnabled = input.enabled;
      if (input.channels !== undefined) {
        // 通道开关是部分更新：先取现值再逐项合并，漏传的通道保持原样
        const current = repository.getSettings().relayChannels;
        patch.relayChannels = {
          trae: input.channels.trae ?? current.trae,
          workbuddy: input.channels.workbuddy ?? current.workbuddy,
          qoder: input.channels.qoder ?? current.qoder,
        };
      }
      repository.updateSettings(patch);
      const settings = repository.getSettings();
      // 装配 / 释放是异步的（读凭据、起 shim、拉目录），等它完成再回，
      // 前端据此把 loading 一直显示到通道真的就绪。
      await relay?.reconfigure({ enabled: settings.relayEnabled, channels: settings.relayChannels });
      return { data: relayStatus(repository, relay) };
    } catch (error) {
      sendAdminError(reply, error);
    }
  });
}
