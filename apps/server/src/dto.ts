import type { ChannelDto, RequestLogDto } from '@aihub/shared';

import { maskSecret, Repository } from './db.js';
import type { ChannelRecord } from './types.js';

export function channelToDto(channel: ChannelRecord): ChannelDto {
  return {
    id: channel.id,
    name: channel.name,
    protocol: channel.protocol,
    baseUrl: channel.baseUrl,
    apiKeyMasked: maskSecret(channel.apiKey),
    defaultMaxTokens: channel.defaultMaxTokens,
    enabled: channel.enabled,
    models: channel.models,
    modelMap: channel.modelMap,
    extraKeyCount: channel.extraApiKeys.length,
    position: channel.position,
    createdAt: channel.createdAt,
    updatedAt: channel.updatedAt,
  };
}

export function logsToDto(repository: Repository, query: Parameters<Repository['listLogs']>[0]): RequestLogDto[] {
  return repository.listLogs(query) as RequestLogDto[];
}
