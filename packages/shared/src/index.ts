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
  modelMap: Record<string, string>;
  extraKeyCount: number;
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
  logRetentionDays: number;
  /** 当前用户登录 Windows 后是否会启动已构建的网关 */
  launchAtLogin: boolean;
  launchAtLoginSupported: boolean;
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

/** 一个已启用订阅模型的上游能力。缺省字段表示目录没有声明。 */
export interface ModelCapabilityDto {
  /** 调用 ID，形如 `wb/hy3` */
  id: string;
  name: string;
  prefix: string;
  /** 通道显示名，如 `WorkBuddy (国际版)` */
  channel: string;
  contextWindow?: number;
  /** 单次输出上限 */
  maxTokens?: number;
  reasoning?: {
    supported: boolean;
    efforts?: string[];
    defaultEffort?: string;
  };
  defaultReasoningEffort?: string;
  supportsImages?: boolean;
  creditRate?: string;
}

export interface ModelCapabilityErrorDto {
  prefix: string;
  label: string;
  message: string;
}

/** 一次经过本网关的订阅请求。token 为空表示上游没有返回 usage。 */
export interface UsageEntryDto {
  id: number;
  createdAt: number;
  virtualModel: string;
  modelName: string | null;
  channelId: string | null;
  channelName: string | null;
  status: 'ok' | 'error' | 'aborted' | 'upstream_error';
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  cachedTokens: number | null;
  /** 请求当时目录上的积分倍率 */
  creditRate: string | null;
  /** (输入 + 输出) token × 倍率 / 1000；缺少 token 或倍率时为空 */
  credits: number | null;
}

/** 按通道和模型汇总的订阅用量 */
export interface UsageSummaryDto {
  channelId: string | null;
  channelName: string | null;
  model: string;
  modelName: string | null;
  requests: number;
  promptTokens: number | null;
  completionTokens: number | null;
  creditRate: string | null;
  /** 该模型已记下 token 的请求，按倍率折算的积分合计 */
  credits: number | null;
}

export interface UsageReportDto {
  summary: UsageSummaryDto[];
  entries: UsageEntryDto[];
}

/** 模型能力页的一次快照。fetchedAt 为 null 表示中转未装配、没有请求上游。 */
export interface ModelCapabilitiesDto {
  models: ModelCapabilityDto[];
  fetchedAt: number | null;
  errors: ModelCapabilityErrorDto[];
}
