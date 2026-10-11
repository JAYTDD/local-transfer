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
  position: number;
  createdAt: number;
  updatedAt: number;
}

export interface LogRecordInput {
  createdAt: number;
  virtualModel: string;
  channelId: string | null;
  channelName: string | null;
  protocol: UpstreamProtocol | null;
  upstreamModel: string | null;
  stream: boolean;
  status: 'ok' | 'error' | 'aborted' | 'upstream_error';
  httpStatus: number | null;
  durationMs: number;
  errorSummary: string | null;
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
}
