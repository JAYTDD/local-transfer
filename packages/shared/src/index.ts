export type UpstreamProtocol = 'openai' | 'responses' | 'anthropic';

export interface ChannelDto {
  id: string;
  name: string;
  protocol: UpstreamProtocol;
  baseUrl: string;
  apiKeyMasked: string;
  defaultMaxTokens: number;
  enabled: boolean;
  models: string[];
  position: number;
  createdAt: number;
  updatedAt: number;
}

export interface ChannelTestResult {
  ok: boolean;
  latencyMs: number;
  httpStatus: number | null;
  errorSummary: string | null;
}

export interface RequestLogDto {
  id: number;
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

export interface SettingsDto {
  gatewayToken: string;
  connectTimeoutMs: number;
  streamIdleTimeoutMs: number;
}

export interface PullModelsResult {
  models: Array<{ id: string; displayName?: string }>;
  latencyMs: number;
}

export interface ApiErrorBody {
  error: {
    message: string;
    type: string;
    code: string;
    param?: string;
    upstream?: {
      attempts: Array<{
        channelId: string;
        channelName: string;
        protocol: UpstreamProtocol;
        status?: number;
        reason: string;
        durationMs: number;
      }>;
    };
  };
}
