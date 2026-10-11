/**
 * Qoder 供应商：从 dsh-qoder-connect 提取协议层，装配成独立的
 * OpenAI 兼容 loopback shim。
 *
 * ⚠️ 两个与另外两个插件不同的地方，改之前先看这里：
 *
 * 1. **transport 与 getMachineId 没从包根导出**。包的 `exports` 只暴露
 *    `.` / `./client` 等，`import 'dsh-qoder-connect/lib/variants-CFI6-cGn.js'`
 *    会报 ERR_PACKAGE_PATH_NOT_EXPORTED。这里按**绝对路径**导入同一个文件
 *    （本地 vendor 的副本，路径自己算），所以能拿到 `createQoderTransport`。
 *    这是本项目能接 Qoder 的关键——PROJECT.md 早期版本说"未导出所以接不了"，
 *    那个结论是错的。
 *
 * 2. **attachments 是必填依赖，哪怕只发纯文本**。transport 的
 *    `enforceImageLimits()` 会无条件读 `attachments.imageLimits`，缺了就在
 *    chat 路径上抛 TypeError。而且这个 TypeError 会被 `failureResult()` 的
 *    LlmError 分支掩盖成 "reading 'status'" 的 502，排查时极具误导性。
 *    本地网关不做图片输入，所以给一个只提供 imageLimits 的桩，
 *    图片相关方法直接明确报错而不是假装成功。
 *
 * 3. **shim.baseUrl 与 shim.token 是函数**，要 `shim.baseUrl()` 调用；
 *    Trae/WorkBuddy 的 shim 是字符串。
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as qoder from 'dsh-qoder-connect';
import { statePath } from '../state-dir.mjs';
import { createChannelPrefs } from '../channel-prefs.mjs';
import { CheckInScheduler, beijingToday } from '../checkin-scheduler.mjs';

const logger = {
  warn: (...a) => console.error('[qoder][warn]', ...a),
  error: (...a) => console.error('[qoder][error]', ...a),
};

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * 从包内 lib 目录按绝对路径取未导出的内部符号。
 * 包名可能出现在本项目的 node_modules，也可能只在 shims/ 下，两个都试。
 */
async function loadInternals() {
  const candidates = [
    path.resolve(HERE, '..', '..', 'node_modules', 'dsh-qoder-connect', 'lib', 'variants-CFI6-cGn.js'),
    path.resolve(HERE, '..', '..', 'shims', 'node_modules', 'dsh-qoder-connect', 'lib', 'variants-CFI6-cGn.js'),
  ];
  let lastErr;
  for (const file of candidates) {
    try {
      const mod = await import(pathToFileURL(file).href);
      if (typeof mod.b !== 'function' || typeof mod.x !== 'function') {
        throw new Error(`内部导出不符合预期（b=${typeof mod.b}, x=${typeof mod.x}）`);
      }
      // validateApiKey（别名 y）也未从包根导出，PAT 手动录入要用它做上游校验
      if (typeof mod.y !== 'function') {
        throw new Error(`内部导出缺少 validateApiKey（y=${typeof mod.y}）`);
      }
      return { createQoderTransport: mod.b, getMachineId: mod.x, validateApiKey: mod.y, file };
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(
    `无法加载 dsh-qoder-connect 的 transport 实现（未从包根导出，需按路径导入）：${lastErr?.message ?? lastErr}`,
  );
}

/** 图片输入的明确拒绝：本地网关不装配图片链路 */
function unsupportedAttachments() {
  const reject = () => {
    throw new Error('local-relay: Qoder image input is not supported by this gateway');
  };
  return {
    // transport 在 chat 路径上无条件读这个字段（即使消息里没有图片）
    imageLimits: {
      maxImagesPerMessage: 0,
      maxMessageImageBytes: 0,
      maxImageBytes: 0,
      maxImagePixels: 0,
    },
    readImageRequest: async () => reject(),
    saveImage: async () => reject(),
  };
}

/**
 * @param {'cn'|'global'} variantId
 */
export async function createQoderProvider(variantId) {
  const variant = variantId === 'global' ? qoder.GLOBAL_VARIANT : qoder.CHINA_VARIANT;
  const fallback = qoder.FALLBACK_QODER_MODELS;
  const { createQoderTransport, getMachineId, validateApiKey } = await loadInternals();
  const prefs = createChannelPrefs({ channel: 'qoder', variant: variantId });
  // 签到记录（源 JsonFileCheckInStore 语义：记录 + 日志，可清空）
  const checkInStore = createChannelPrefs({ channel: 'qoder-checkin', variant: variantId });

  const pref = (key, fallbackValue) => {
    const value = prefs.get()[key];
    return value === undefined ? fallbackValue : value;
  };

  const store = new qoder.QoderCredentialStore({ variant, logger });
  const attachments = unsupportedAttachments();

  const transport = createQoderTransport({
    region: variant.region,
    resolvePat: () => store.patPromise(),
    resolveMachineId: () => getMachineId([qoder.qoderPluginDataDir() + path.sep + 'machine_id']),
    logger,
    attachments,
  });

  const client = new qoder.QoderUpstreamClient({
    region: variant.region,
    providerId: variant.id,
    getPat: () => store.patPromise(),
    transport,
    attachments,
  });

  const catalog = new qoder.QoderCatalog(fallback);
  // 插件默认不可见，发现成功后才 setVisible(true)；独立网关直接暴露
  catalog.setVisible(true);

  /** 目录设置（源 applyCatalogSettings 语义）：三项都从偏好读取后套到 catalog */
  const applyCatalogSettings = () => {
    catalog.setUseMaximumContextWindow(pref('useMaximumContextWindow', true) === true);
    const overrides = prefs.get().modelContextWindows;
    if (overrides !== undefined && typeof overrides === 'object') catalog.setModelContextWindows(overrides);
    catalog.setDisabledModels(Array.isArray(prefs.get().disabledModels) ? prefs.get().disabledModels : []);
  };
  applyCatalogSettings();

  // 状态文件与 DSH 插件隔离（同 WorkBuddy 的理由：persist() 是全量覆盖写）
  const savedCatalogs = new qoder.QoderCatalogStore({
    path: statePath(`qoder-catalog.${variantId}.json`),
  });
  const probeStore = new qoder.QoderProbeStore({
    pluginVersion: 'local-relay/0.1.0',
    path: statePath(`qoder-probe.${variantId}.json`),
  });

  /** 目录来源（面板要能说明这批模型是哪来的） */
  let catalogSource = { source: 'fallback' };
  /** 上次成功/尝试拉取的时刻（sweep 的陈旧目录重试用） */
  let lastFetchAtMs = 0;

  /**
   * 账号键（按 PAT 的 sha256 前 16 位，源 qoderCredentialIdentity 的设计：
   * PAT 是 bearer 密钥，键用单向哈希，面板显示它不泄漏任何可用信息）。
   * 必须是**同步**读取——探针服务把它当 Map 键做恒等比较。
   */
  let cachedAccount;

  const refreshAccount = async () => {
    try {
      const pat = await store.patPromise();
      cachedAccount = pat === undefined || pat === '' ? undefined : qoder.qoderCredentialIdentity({ pat });
    } catch {
      cachedAccount = undefined;
    }
    return cachedAccount;
  };

  const account = () => cachedAccount;

  const probeService = new qoder.QoderProbeService({
    store: probeStore,
    catalog,
    credentials: store,
    client,
    // 面板可开关（偏好 probeConsent，默认关）；手动点击始终走一次性同意
    consent: () => prefs.get().probeConsent === true,
    account,
  });

  /**
   * 签到：执行 + 记录（源 apply() 的 checkIn 动作语义）。
   * client.checkIn() 内部处理换新 token 重试；非 error 结果写记录，
   * 成功领取后顺手刷新额度缓存。
   */
  const runCheckIn = async () => {
    const result = await client.checkIn();
    if (result.status !== 'error') {
      const record = {
        lastDate: result.date,
        lastAt: result.timestamp,
        lastStatus: result.status,
        ...(result.amount === undefined ? {} : { amount: result.amount }),
        ...(result.message === undefined ? {} : { message: result.message }),
      };
      const saved = checkInStore.get();
      const logs = [{ ...record, date: result.date, status: result.status }, ...(saved.logs ?? [])].slice(0, 30);
      checkInStore.patch({ checkin: record, logs });
      if (result.status === 'claimed') client.fetchCredits().catch(() => {});
    }
    return result;
  };

  /** 自动签到调度器（源 CheckInScheduler 语义：每日 checkInMinute 时刻，UTC+8） */
  const scheduler = new CheckInScheduler({
    isEnabled: () => pref('autoCheckIn', false) === true,
    minute: () => pref('checkInMinute', 600),
    run: runCheckIn,
    lastRecord: () => checkInStore.get().checkin,
  });

  return {
    id: variant.id,
    label: variant.displayName,
    providerPrefix: variantId === 'global' ? 'qoderg' : 'qoder',
    shim: null,
    store,
    client,
    transport,
    savedCatalogs,
    probeStore,
    probeService,
    account,
    prefs,
    checkInStore,
    catalogSource: () => ({ ...catalogSource }),

    async start() {
      await refreshAccount();

      // 先用上次保存的目录，让重启后头几秒也有真实模型
      const saved = savedCatalogs.get(account());
      if (saved !== undefined && Array.isArray(saved.models) && saved.models.length > 0) {
        catalog.set(saved.models);
        catalogSource = {
          source: 'saved',
          ...(saved.fetchedAtMs === undefined ? {} : { fetchedAtMs: saved.fetchedAtMs }),
        };
      }
      applyCatalogSettings();

      const shim = qoder.createQoderShim({
        store,
        client,
        catalog,
        logger,
        providerId: variant.id,
      });
      await shim.ready;
      this.shim = shim;
      await this.refreshModels();
      // 自动签到：启动补签（今天没签就立即补），然后排每日定时
      await scheduler.catchUp(variantId);
      scheduler.arm(variantId);
      return this;
    },

    async refreshModels() {
      // 单飞：并发调用共享一次拉取（源 fetchCatalog 的 in-flight 语义）
      if (this._inflightFetch !== undefined) return this._inflightFetch;
      const run = (async () => {
        const errors = [];
        try {
          await refreshAccount();
          const models = await client.fetchModels();
          if (Array.isArray(models) && models.length > 0) {
            catalog.set(models);
            catalogSource = { source: 'live', fetchedAtMs: Date.now() };
            const key = account();
            if (key !== undefined) {
              // 写失败被 store 吞掉（源行为）
              savedCatalogs.set(key, { source: 'qoder:discovery', fetchedAtMs: Date.now(), models });
            }
          }
          catalog.setVisible(true);
        } catch (e) {
          errors.push(e.message);
          catalogSource = { source: catalogSource.source, error: e.message };
          catalog.setVisible(true); // 至少暴露 fallback
        } finally {
          lastFetchAtMs = Date.now();
        }
        return { models: catalog.current(), errors };
      })();
      this._inflightFetch = run;
      try {
        return await run;
      } finally {
        if (this._inflightFetch === run) this._inflightFetch = undefined;
      }
    },

    /**
     * 凭据 sweep（源 syncVariant 语义）：PAT 换新（账号键变化）→ 重拉目录；
     * 目录仍非实时且距上次拉取超过 10 个周期 → 自动重试。
     */
    startSweep() {
      if (this._sweepTimer !== undefined) return;
      let lastSeenAccount;
      const pollMs = Math.max(60_000, Number(process.env.RELAY_QODER_POLL_MS) || 300_000);
      const sweep = async () => {
        try {
          const current = await refreshAccount();
          if (current !== lastSeenAccount) {
            lastSeenAccount = current;
            if (current !== undefined) return void (await this.refreshModels());
          }
          if (catalogSource.source !== 'live' && Date.now() - lastFetchAtMs >= pollMs * 10) {
            await this.refreshModels();
          }
        } catch { /* sweep 不打断网关 */ }
      };
      this._sweepTimer = setInterval(() => void sweep(), pollMs);
      this._sweepTimer.unref?.();
    },

    models() {
      return catalog.current();
    },
    /**
     * 面板展示用全量目录。catalog.current() 会剔除停用模型（源类语义），
     * 面板若也用它，停用的行会直接消失、永远无法再启用——必须用 all()。
     */
    displayModels() {
      return catalog.all();
    },

    /* ---------- 面板写操作（对应源 probe-route 的 action 面） ---------- */

    /** 清空全部探针记录（源 clear 动作） */
    clearProbe() {
      probeStore.clear();
      return { state: 'cleared' };
    },
    /** 最大上下文开关（源 set-maximum-context-window，按变体独立） */
    setMaximumContextWindow(enabled) {
      prefs.patch({ useMaximumContextWindow: enabled === true });
      catalog.setUseMaximumContextWindow(enabled === true);
      return { state: 'updated', enabled: enabled === true };
    },
    /** 模型启停（源 set-models-enabled：黑名单 wholesale 替换） */
    setModelsEnabled({ models, enabled }) {
      const disabled = new Set(catalog.getDisabledModels?.() ?? pref('disabledModels', []));
      for (const m of models ?? []) {
        if (enabled === true) disabled.delete(m);
        else disabled.add(m);
      }
      prefs.patch({ disabledModels: [...disabled] });
      catalog.setDisabledModels([...disabled]);
      return { state: 'updated', disabledModels: [...disabled] };
    },
    /** 每模型上下文窗口覆盖（源 modelContextWindows 配置） */
    setModelContextWindows(overrides) {
      const clean = {};
      for (const [id, value] of Object.entries(overrides ?? {})) {
        if (typeof value === 'number' && Number.isFinite(value) && value >= 1) clean[id] = Math.floor(value);
      }
      prefs.patch({ modelContextWindows: clean });
      catalog.setModelContextWindows(clean);
      return { state: 'updated' };
    },
    /** 探针同意（源 probeConsent 配置） */
    setProbeConsent(enabled) {
      prefs.patch({ probeConsent: enabled === true });
      return { state: 'updated', enabled: enabled === true };
    },
    /** 手动签到（源 checkin 动作） */
    async checkIn() {
      const result = await runCheckIn();
      return {
        state: result.status,
        ...(result.amount === undefined ? {} : { amount: result.amount }),
        ...(result.message === undefined ? {} : { reason: result.message }),
      };
    },
    /** 签到记录与日志（面板展示用） */
    checkInStatus() {
      const saved = checkInStore.get();
      return {
        ...(saved.checkin === undefined ? {} : { checkin: saved.checkin }),
        ...(saved.logs === undefined ? {} : { logs: saved.logs }),
        nextRunAt: scheduler.nextRunAt(variantId),
      };
    },
    /** 清空签到日志（源 clear-checkin-logs 动作；checkin 记录保留，见源 clearLogs） */
    clearCheckInLogs() {
      checkInStore.patch({ logs: [] });
      return { state: 'cleared' };
    },
    /** 自动签到开关 */
    setAutoCheckIn(enabled) {
      prefs.patch({ autoCheckIn: enabled === true });
      scheduler.arm(variantId);
      return { state: 'updated', enabled: enabled === true };
    },
    /** 自动签到时刻（自 UTC+8 午夜起的分钟数） */
    setCheckInMinute(minute) {
      const value = Number(minute);
      if (!Number.isInteger(value) || value < 0 || value > 1439) {
        return { state: 'failed', reason: 'checkInMinute must be an integer between 0 and 1439' };
      }
      prefs.patch({ checkInMinute: value });
      scheduler.arm(variantId);
      return { state: 'updated', checkInMinute: value };
    },
    /** 保存 PAT（源 auth 路由的 save：先验证再落盘） */
    async savePat(pat) {
      if (typeof pat !== 'string' || pat.trim() === '') {
        return { state: 'failed', reason: 'PAT is required' };
      }
      if (!(await validateApiKey(pat.trim(), variant.region))) {
        return { state: 'failed', reason: 'PAT 校验失败：不是有效的 Qoder 令牌' };
      }
      await store.save(pat.trim());
      await refreshAccount();
      await this.refreshModels();
      return { state: 'updated' };
    },
    /** 清除网关自存的 PAT 副本（源 auth 路由的 clear） */
    async clearPat() {
      await store.clear();
      await refreshAccount();
      return { state: 'updated' };
    },
    async logout() {
      await store.logout();
      await refreshAccount();
      return { state: 'updated' };
    },

    async close() {
      scheduler.dispose();
      if (this._sweepTimer !== undefined) clearInterval(this._sweepTimer);
      await this.shim?.close();
    },
  };
}

export const QODER_VARIANTS = ['cn', 'global'];
