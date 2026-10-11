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
  protocol: UpstreamProtocol | 'relay' | null;
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

/** relay 模块（订阅中转）的三个通道开关，每个键控制该通道的国内 + 国际两个变体 */
export interface RelayChannelToggle {
  trae: boolean;
  workbuddy: boolean;
  qoder: boolean;
}

/** relay 模块的开关设置 */
export interface RelaySettingsDto {
  /** 总开关；关闭时模块完全不装配 */
  enabled: boolean;
  channels: RelayChannelToggle;
}

/** 单个通道前缀（如 `trae/`）的运行状态 */
export interface RelayPrefixStatusDto {
  prefix: string;
  label: string;
  channel: keyof RelayChannelToggle;
  models: number;
  /** 被面板停用的区域为 false；缺省表示启用 */
  enabled?: boolean;
  error?: string;
}

/** relay 模块的完整状态：开关 + 装配结果 */
export interface RelayStatusDto extends RelaySettingsDto {
  ready: boolean;
  prefixes: RelayPrefixStatusDto[];
}
