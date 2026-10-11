/**
 * Trae 供应商：从 dsh-connect-trae 提取协议层，装配成一个独立的
 * OpenAI 兼容 loopback shim。
 *
 * 依赖注入式构造（credential/identity/fetchImpl）是插件原本就提供的，
 * 这里只负责把它们按插件 apply() 里的顺序串起来。
 *
 * 插件 apply() 的其余能力也在这里对齐：
 *   - 每区域启停（regions.[r].enabled；关闭的区域不对外提供模型）
 *   - 账号切换（store.selectAccount；选择持久化到偏好文件）
 *   - 模型选集 / 图片选集 / 每模型上下文预算（deriveCatalog 的三个输入）
 *   - authFile / edition 覆盖（环境变量 RELAY_TRAE_AUTH_FILE / RELAY_TRAE_EDITION）
 *   - 目录读取一次性重试（withDirectoryRetry，间歇 401 的教训）
 *   - CN Raw Chat 网关（条件装配：sqlite3 CLI 可用时才启用，失败退回 SOLO）
 */
import * as trae from 'dsh-connect-trae';
import { createChannelPrefs } from '../channel-prefs.mjs';

const logger = {
  warn: (...a) => console.error('[trae][warn]', ...a),
  error: (...a) => console.error('[trae][error]', ...a),
};

export const TRAE_REGIONS = ['cn', 'ai'];

/** 丢弃"Remote 广告了、但 get_detail_param 没有匹配项"的死 config_name（源 dropDeadModels）。 */
export function dropDeadModels(rows, wire) {
  if (!wire.resolved) return rows;
  return rows.filter(
    (m) =>
      wire.callableKeys.has(String(m.id).trim().toLowerCase()) ||
      wire.callableKeys.has(String(m.name ?? '').trim().toLowerCase()),
  );
}

/** 插件同款：目录读取失败歇 800ms 重试一次（间歇 401 的教训，源 withDirectoryRetry）。 */
async function withDirectoryRetry(read) {
  try {
    return await read();
  } catch (first) {
    await new Promise((resolve) => setTimeout(resolve, 800));
    try {
      return await read();
    } catch {
      throw first;
    }
  }
}

/**
 * 为一个区域装配 Trae 栈。
 * @param {string} region 'cn' | 'ai'
 */
export function createTraeProvider(region) {
  const catalog = new trae.TraeCatalog(region);
  const prefs = createChannelPrefs({ channel: 'trae', variant: region });

  // 本区域的 wire 状态。CN 与国际版名册重叠（有些 id 拼写不同），
  // 共享一张 map 会让一个区域的答案过滤掉另一个区域的目录。
  const wire = {
    callableKeys: new Set(),
    resolved: false,
    byId: new Map(),
    byName: new Map(),
  };

  // identity 需要 store 已就绪，先声明后引用
  let store;

  /** 偏好读取（带默认值） */
  const pref = (key, fallback) => {
    const value = prefs.get()[key];
    return value === undefined ? fallback : value;
  };
  const isEnabled = () => pref('enabled', true) === true;
  const enabledSet = () => new Set(pref('enabledModelIds', []));
  const imageSet = () => new Set(pref('imageModelIds', []));
  const budgets = () => pref('contextBudgets', {});

  const authFile = process.env.RELAY_TRAE_AUTH_FILE?.trim() || undefined;
  const editionHint = process.env.RELAY_TRAE_EDITION?.trim() || undefined;

  const identity = async () => {
    let preferred;
    try { preferred = (await store.current())?.edition; } catch { /* 未登录时忽略 */ }
    // 插件语义：显式 edition 配置优先，其次所选凭据自己的 edition
    const hint = editionHint ?? preferred;
    const candidates = authFile !== undefined
      ? [{ edition: hint ?? (region === 'ai' ? 'solo-sg' : 'cn'), path: authFile, source: 'desktop' }]
      : trae.traeStorageCandidates().filter(
          (item) => item.source === 'desktop' && (hint !== undefined ? item.edition === hint : true),
        );
    return trae.resolveTraeIdentity(candidates, hint ?? (region === 'ai' ? 'solo-sg' : 'cn'));
  };

  const refreshDeviceSafe = async () => {
    try {
      const v = await identity();
      return { deviceId: v.deviceId, machineId: v.machineId };
    } catch {
      return undefined;
    }
  };

  store = new trae.TraeCredentialStore({
    region,
    ...(authFile === undefined ? {} : { storagePath: authFile }),
    edition: editionHint ?? 'auto',
    // 启动即恢复上次选择的账号（插件由 config accounts.{cn,ai} 持久化）
    accountId: pref('selectedAccountId', undefined),
    refresh: async (credential) => trae.refreshTraeCredential(credential, undefined, await refreshDeviceSafe()),
  });

  const solo = new trae.TraeSoloUpstreamClient({
    credential: () => store.resolve(),
    identity,
    log: (message, detail) => logger.warn(message, detail),
  });

  const remoteCatalog = new trae.TraeSoloRemoteCatalogClient({ credential: () => store.resolve() });
  const wireResolver = (displayId) =>
    wire.byId.get(displayId) ?? wire.byName.get(String(displayId).trim().toLowerCase());

  const upstream = new trae.TraeSoloBridge(solo, catalog, wireResolver);
  const delegating = new trae.TraeDelegatingUpstreamClient(upstream);

  // CN Raw Chat 网关（源 apply() 同款条件装配）：sqlite3 CLI 不可用或状态库
  // 读不到时退回 SOLO 通道，网关行为不变，诊断如实报告。
  let rawDiagnostic = () => ({ state: 'disabled' });
  if (region === 'cn') {
    void (async () => {
      try {
        const resolved = await trae.resolveTraeRawRuntime(store, 'qwen-3.7-plus');
        const gateway = trae.createTraeRawGateway({
          raw: new trae.TraeRawChatUpstreamClient({
            credential: () => store.resolve(),
            identity: async () => resolved.identity,
            config: {
              model: resolved.runtime.modelName,
              configName: resolved.runtime.configName,
              passBackReasoning: true,
              runtime: resolved.runtime,
            },
          }),
          solo: upstream,
          endpoint: `${trae.REGION_GATEWAYS.cn.chat}/api/ide/v2/llm_raw_chat`,
          edition: resolved.identity.edition,
          identity: {
            appVersion: resolved.identity.appVersion ?? '',
            buildVersion: resolved.identity.buildVersion ?? '',
          },
          runtime: resolved.runtime,
          enabled: false,
        });
        delegating.replace(gateway.upstream);
        rawDiagnostic = () => gateway.diagnostic();
      } catch (e) {
        logger.warn('Raw gateway unavailable; continuing with native SOLO tool-call channel', e.message);
      }
    })();
  }

  // 额度/签到客户端（源 apply() 同款装配）。CN 与 AI 的取数契约不同。
  const usage = new trae.TraeUsageClient({
    credential: () => store.resolve(),
    deviceId: async () => (await identity()).deviceId,
  });

  /** 面板展示目录：只剔死模型，不应用选集（源 displayModels 语义——选集只影响对话） */
  const displayModels = (rows) => dropDeadModels(trae.sanitizeCatalog(rows), wire);

  /** 对话目录：清洗 → 图片选集 → 死模型 → 启用选集 + 预算（源 derive 语义） */
  const derive = (rows) =>
    trae.deriveCatalog(
      trae.applyImageSelection(dropDeadModels(trae.sanitizeCatalog(rows), wire), imageSet()),
      enabledSet(),
      budgets(),
    );

  return {
    id: region === 'ai' ? 'trae-global' : 'trae',
    label: region === 'ai' ? 'Trae (国际版)' : 'Trae (国内版)',
    providerPrefix: region === 'ai' ? 'traeg' : 'trae',
    region,
    enabled: isEnabled,
    // 供面板查询真实登录态与账号（只读；不暴露 token）
    store,
    // 供面板查询额度/签到（只读部分；写操作只有 checkin）
    usage,
    prefs,
    rawDiagnostic: () => rawDiagnostic(),
    shim: null, // start() 时填充
    async start() {
      const shim = trae.createTraeShim({ catalog, client: delegating, logger });
      await shim.ready;
      this.shim = shim;
      await this.refreshModels();
      return this;
    },
    async refreshModels() {
      const lastErr = [];
      let remote = [];
      let local = [];
      try {
        remote = await withDirectoryRetry(() => remoteCatalog.fetchModels());
      } catch (e) {
        lastErr.push(`remote: ${e.message}`);
      }
      try {
        local = await withDirectoryRetry(() => solo.fetchModels());
      } catch (e) {
        lastErr.push(`wire: ${e.message}`);
      }
      const merged = trae.mergeTraeModelSources(remote, local);

      // 记录本区域确认可调用的显示键（源 discoverModels）
      wire.callableKeys.clear();
      for (const model of merged) {
        wire.callableKeys.add(String(model.id).trim().toLowerCase());
        wire.callableKeys.add(String(model.name).trim().toLowerCase());
      }
      wire.resolved = merged.length > 0;

      wire.byId.clear();
      wire.byName.clear();
      for (const model of merged) {
        if (model.wireConfigName !== undefined) {
          const target = {
            configName: model.wireConfigName,
            ...(model.wireFunction === undefined ? {} : { function: model.wireFunction }),
          };
          wire.byId.set(model.id, target);
          wire.byName.set(String(model.name).trim().toLowerCase(), target);
        }
      }

      // 插件语义：derive 结果为空则退回该区域的兜底名册（应用同一选集），
      // 且写进 catalog 的是 derive 后的结果（否则死模型会在下次启动复活）。
      // 合并目录留在 lastMerged：选集变化只需本地 derive，不必重新打上游。
      this.lastMerged = merged;
      return { ...this.applySelection(), errors: lastErr };
    },
    models() {
      return catalog.current();
    },
    /** 面板展示用全量目录（选集只影响对话，管理界面要能看到全部） */
    displayModels() {
      return this.lastDisplay ?? catalog.current();
    },
    /** 用最近的合并目录重算对话/展示目录（选集只影响 derive，不需要重新打上游） */
    applySelection() {
      const merged = this.lastMerged;
      if (merged === undefined) return this.refreshModels();
      const derived = derive(merged);
      const final = derived.length > 0
        ? derived
        : trae.applyImageSelection(trae.fallbackModelsFor(region), imageSet());
      catalog.set(final);
      this.lastDisplay = displayModels(merged);
      return { models: final, display: this.lastDisplay };
    },
    /** 以下为面板写操作；每项都落盘偏好并立即生效（源 applySelection 语义） */
    async selectAccount(accountId) {
      prefs.patch({ selectedAccountId: accountId });
      store.selectAccount(accountId);
      // 账号变了目录/倍率就是旧账号的——独立网关没有 sweep 兜底，必须立刻重拉
      await this.refreshModels();
      return { state: 'updated' };
    },
    async setEnabled(value) {
      prefs.patch({ enabled: value === true });
      return { state: 'updated', enabled: value === true };
    },
    async setModelSelection(ids) {
      prefs.patch({ enabledModelIds: Array.isArray(ids) ? ids.filter((x) => typeof x === 'string' && x) : [] });
      // 选集只影响对话目录；重算当前目录
      await this.applySelection();
      return { state: 'updated' };
    },
    async setImageSelection(ids) {
      prefs.patch({ imageModelIds: Array.isArray(ids) ? ids.filter((x) => typeof x === 'string' && x) : [] });
      await this.applySelection();
      return { state: 'updated' };
    },
    async setContextBudgets(map) {
      const clean = {};
      for (const [id, value] of Object.entries(map ?? {})) {
        if (typeof value === 'number' && Number.isFinite(value) && value >= 1) clean[id] = Math.floor(value);
      }
      prefs.patch({ contextBudgets: clean });
      await this.applySelection();
      return { state: 'updated' };
    },
    async logout() {
      await store.logout();
      return { state: 'updated' };
    },
    async close() {
      await this.shim?.close();
    },
  };
}
