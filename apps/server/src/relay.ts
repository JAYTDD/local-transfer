/**
 * relay 模块的宿主适配层。
 *
 * `@aihub/relay` 是纯 .mjs（零运行期依赖、不参与 AiHub 的 tsc 构建、也没有类型
 * 声明），所以这里用**变量形式**的动态 import 拿到它——specifier 声明成 string
 * 类型，让 TypeScript 跳过模块解析，所需形状由下面就地约定。这样既不给整个包造
 * d.ts，也不让 AiHub 的构建去读它的源码。
 *
 * 本层的职责只有三件：
 *   1. 按 SQLite settings 的开关装配 / 释放 relay 网关；
 *   2. 把网关能力转成 AiHub 需要的样子（模型列表、路由分流、面板托管）；
 *   3. 装配失败时降级成"模块不可用"，绝不让 AiHub 起不来。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

import type {
  ModelCapabilitiesDto,
  RelayChannelToggle,
  RelayPrefixStatusDto,
  RelaySettingsDto,
} from '@aihub/shared';

import type { LogRecordInput } from './types.js';

/** relay 的模型条目：比 AiHub /v1/models 多几个给客户端模型选择器看的字段 */
export interface RelayModel {
  id: string;
  object: 'model';
  created: number;
  owned_by: string;
  name?: string;
  context_window?: number;
  max_tokens?: number;
  reasoning?: boolean;
}

/**
 * 面板 API 的请求描述。宿主是 Fastify 时，它在进入 relay 前已经解析并消费了
 * 请求流，所以把结果通过 body 传给 relay；独立运行时省略 body 即走流读取。
 */
export interface RelayPanelRequest {
  method?: string;
  url?: string;
  headers: IncomingMessage['headers'];
  body?: unknown;
}

export interface RelayPanelApi {
  handle(request: RelayPanelRequest, response: ServerResponse, pathname: string): Promise<boolean>;
}

export interface RelayGateway {
  start(): Promise<void>;
  stop(): Promise<void>;
  listModels(): RelayModel[];
  modelCapabilities(options?: { force?: boolean }): Promise<ModelCapabilitiesDto>;
  /** 当前目录里的显示名和倍率，键是 `前缀/模型ID` */
  usageCatalog(): Record<string, { modelName?: string; creditRate?: string }>;
  handleChat(body: unknown, response: ServerResponse): Promise<void>;
  panelApi: RelayPanelApi;
  prefixes: string[];
  isServingPrefix(prefix: string): boolean;
  status(): RelayPrefixStatusDto[];
  readonly ready: boolean;
}

interface RelayModuleExports {
  createRelayGateway(options: {
    channels?: RelayChannelToggle;
    endpoint?: () => string;
    onLog?: (entry: RelayLogEntry) => void;
  }): RelayGateway;
  CHANNEL_PREFIXES: string[];
  CHANNEL_KEYS: string[];
}

/**
 * 变量形式的 specifier：显式标成 string 是为了让 TS 不去解析这个无类型声明的
 * 包（否则会报 TS7016）。运行时 Node 照常按包名解析。
 */
const RELAY_SPECIFIER: string = '@aihub/relay';

let relayModulePromise: Promise<RelayModuleExports> | null = null;

function loadRelayModule(): Promise<RelayModuleExports> {
  relayModulePromise ??= import(RELAY_SPECIFIER) as Promise<RelayModuleExports>;
  return relayModulePromise;
}

/** 模型名是否带 relay 的六个前缀之一（`trae/` `traeg/` `wb/` `wbai/` `qoder/` `qoderg/`） */
export function hasRelayPrefix(model: unknown, prefixes: readonly string[]): boolean {
  if (typeof model !== 'string' || model === '') return false;
  return prefixes.some((prefix) => model.startsWith(`${prefix}/`));
}

/** 六个前缀的静态副本：模块未装配时也要能判断一个模型名"本该属于 relay" */
export const RELAY_PREFIXES = ['trae', 'traeg', 'wb', 'wbai', 'qoder', 'qoderg'];

export interface RelayModuleOptions {
  /** 宿主对外宣告的 gateway 端点（面板展示用） */
  endpoint: () => string;
  /** relay 请求日志的宿主落点（写入 AiHub request_logs）；抛错由 relay 侧兜住 */
  onLog?: (entry: RelayLogEntry) => void;
}

/** relay 请求日志条目（request-log.mjs 产出的形状） */
export interface RelayLogEntry {
  at?: number;
  channel?: string | null;
  channelLabel?: string | null;
  model?: string | null;
  upstreamModel?: string | null;
  stream?: boolean;
  status?: string;
  httpStatus?: number;
  durationMs?: number;
  error?: string;
  modelName?: string;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  cachedTokens?: number;
  creditRate?: string;
}

function intOrNull(value: number | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : null;
}

/** 目录倍率 `x0.15` / `0.15` → 0.15。解析不了就返回 null。 */
export function parseCreditRate(rate: string | null | undefined): number | null {
  if (!rate) return null;
  const match = /^x?([0-9]+(?:\.[0-9]+)?)$/i.exec(rate.trim());
  if (!match?.[1]) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

/**
 * 积分消耗。Trae 的规则是每 1000 个输入加输出 token 按模型倍率扣分：
 * 积分 = (prompt + completion) × 倍率 / 1000。
 * WorkBuddy、Qoder 目录上的 xN 是同一种消耗速度，沿用同一公式。
 * 缓存 token 已包含在输入 token 里，不再另加。
 */
export function creditCost(input: {
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens?: number | null;
  creditRate: string | null;
}): number | null {
  const rate = parseCreditRate(input.creditRate);
  if (rate === null) return null;
  let tokens: number | null = null;
  if (input.promptTokens !== null || input.completionTokens !== null) {
    tokens = (input.promptTokens ?? 0) + (input.completionTokens ?? 0);
  } else if (input.totalTokens != null) {
    tokens = input.totalTokens;
  }
  if (tokens === null) return null;
  return tokens * rate / 1000;
}

/** 日志里没记下的显示名和倍率，用当前目录补上。已有的记录不覆盖。 */
export function applyUsageCatalog<T extends { model?: string; virtualModel?: string; modelName?: string | null; creditRate?: string | null }>(
  rows: T[],
  catalog: Record<string, { modelName?: string; creditRate?: string }>,
): T[] {
  return rows.map((row) => {
    const key = row.virtualModel ?? row.model;
    const snap = key ? catalog[key] : undefined;
    if (!snap) return row;
    return {
      ...row,
      modelName: row.modelName || snap.modelName || null,
      creditRate: row.creditRate || snap.creditRate || null,
    };
  });
}

/** relay 日志 → AiHub request_logs 记录 */
export function mapRelayLog(entry: RelayLogEntry): LogRecordInput {
  const unknownModel = entry.status === 'unknown-model';
  const status: LogRecordInput['status'] =
    entry.status === 'ok' || entry.status === 'aborted'
      ? entry.status
      : entry.status === 'error' && entry.httpStatus !== undefined
        ? 'upstream_error'
        : 'error';
  return {
    createdAt: Math.floor((entry.at ?? Date.now()) / 1000),
    virtualModel: entry.model ?? '(unknown)',
    channelId: entry.channel ? `relay:${entry.channel}` : null,
    channelName: entry.channelLabel ?? entry.channel ?? null,
    protocol: 'relay',
    upstreamModel: entry.upstreamModel ?? null,
    stream: entry.stream === true,
    status,
    httpStatus: entry.httpStatus ?? (unknownModel ? 404 : null),
    durationMs: entry.durationMs ?? 0,
    errorSummary: entry.error ?? (unknownModel ? `Unknown model: ${entry.model ?? ''}` : null),
    modelName: entry.modelName || null,
    promptTokens: intOrNull(entry.promptTokens),
    completionTokens: intOrNull(entry.completionTokens),
    totalTokens: intOrNull(entry.totalTokens),
    cachedTokens: intOrNull(entry.cachedTokens),
    creditRate: entry.creditRate || null,
  };
}

export interface RelayModule {
  /** 按开关装配 / 释放。串行执行，幂等；装配失败只告警不抛出。 */
  reconfigure(settings: RelaySettingsDto): Promise<void>;
  isActive(): boolean;
  gateway(): RelayGateway | null;
  status(): RelaySettingsDto & { ready: boolean; prefixes: RelayPrefixStatusDto[] };
  dispose(): Promise<void>;
}

export function createRelayModule(options: RelayModuleOptions): RelayModule {
  let active: RelayGateway | null = null;
  let current: RelaySettingsDto = {
    enabled: false,
    channels: { trae: false, workbuddy: false, qoder: false },
  };
  // reconfigure 串行化：并发调用（启动 + 面板切开关）按顺序执行，不会同时起两个网关
  let queue: Promise<void> = Promise.resolve();

  function sameChannels(a: RelaySettingsDto, b: RelaySettingsDto): boolean {
    return (
      a.channels.trae === b.channels.trae &&
      a.channels.workbuddy === b.channels.workbuddy &&
      a.channels.qoder === b.channels.qoder
    );
  }

  async function release(): Promise<void> {
    if (!active) return;
    const gateway = active;
    active = null;
    try {
      await gateway.stop();
    } catch (error) {
      console.warn(`[relay] 释放失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async function apply(settings: RelaySettingsDto): Promise<void> {
    if (!settings.enabled) {
      await release();
      current = settings;
      return;
    }
    if (active && sameChannels(current, settings)) {
      current = settings;
      return;
    }
    await release();
    try {
      const { createRelayGateway } = await loadRelayModule();
      const gateway = createRelayGateway({
        channels: settings.channels,
        endpoint: options.endpoint,
        onLog: options.onLog,
      });
      await gateway.start();
      active = gateway;
    } catch (error) {
      // 装配失败（依赖桩没同步、宿主环境缺东西）只降级，不影响 AiHub 本体
      console.warn(`[relay] 模块装配失败: ${error instanceof Error ? error.message : String(error)}`);
      active = null;
    }
    current = settings;
  }

  return {
    reconfigure(settings: RelaySettingsDto): Promise<void> {
      queue = queue.then(() => apply(settings));
      return queue;
    },

    isActive(): boolean {
      return active !== null;
    },

    gateway(): RelayGateway | null {
      return active;
    },

    status() {
      return {
        ...current,
        ready: active?.ready ?? false,
        prefixes: active?.status() ?? [],
      };
    },

    async dispose(): Promise<void> {
      await release();
    },
  };
}
