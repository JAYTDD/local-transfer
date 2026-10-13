import type { UpstreamProtocol } from '@aihub/shared';

export interface ChannelRecord {
  id: string;
  name: string;
  protocol: UpstreamProtocol;
  baseUrl: string;
  apiKey: string;
  defaultMaxTokens: number;
  enabled: boolean;
  models: string[];
  /** 对外名 → 上游模型名 */
  modelMap: Record<string, string>;
  /** 同一 baseUrl 下，主密钥 429 之后再试的密钥 */
  extraApiKeys: string[];
  position: number;
  createdAt: number;
  updatedAt: number;
}

export interface LogRecordInput {
  createdAt: number;
  virtualModel: string;
  channelId: string | null;
  channelName: string | null;
  protocol: UpstreamProtocol | 'relay' | null;
  upstreamModel: string | null;
  stream: boolean;
  status: 'ok' | 'error' | 'aborted' | 'upstream_error';
  httpStatus: number | null;
  durationMs: number;
  errorSummary: string | null;
  modelName?: string | null;
  promptTokens?: number | null;
  completionTokens?: number | null;
  totalTokens?: number | null;
  cachedTokens?: number | null;
  creditRate?: string | null;
}

export interface LogFilters {
  limit: number;
  offset: number;
  model?: string;
  channelId?: string;
  status?: string;
  stream?: boolean;
  from?: number;
  to?: number;
  protocol?: string;
}
