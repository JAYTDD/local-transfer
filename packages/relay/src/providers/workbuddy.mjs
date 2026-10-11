/**
 * WorkBuddy 供应商：从 dsh-workbuddy-connect 提取协议层。
 * 两个变体（国内 workbuddy / 国际 workbuddy-ai）各自独立的凭据、目录与 shim。
 *
 * ⚠️ store 必须传 keyProvider（原插件 apply() 对两个变体都传，见下方
 * loadKeyProviderFactory 的注释）。漏掉它 wbai 就地报 not_signed_in——
 * 这是移植 wbai 不可用的根因，别再丢。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as wb from 'dsh-workbuddy-connect';
import { statePath } from '../state-dir.mjs';
import { createChannelPrefs } from '../channel-prefs.mjs';

const logger = {
  warn: (...a) => console.error('[workbuddy][warn]', ...a),
  error: (...a) => console.error('[workbuddy][error]', ...a),
};

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * 对话目录过滤：全局停用与账号隐藏取并集（纯函数，便于单测）。
 * 两个集合都为空时返回原引用，避免无谓拷贝。
 */
export function visibleModels(rows, { disabledModels = [], hidden = [] } = {}) {
  const blocked = new Set([...disabledModels, ...hidden]);
  return blocked.size === 0 ? rows : rows.filter((m) => !blocked.has(m.id));
}

/**
 * 原插件 apply() 给**每个**变体的 store 传 keyProvider（index.js 的
 * `atRestKeysFor = (variant) => atRestKeyProviderFor(variant)`），它带着
 * 平台发现模式（Windows 上是注册表找 app）。这个工厂**没有从包根导出**，
 * 而 store 不传 keyProvider 时自建的默认 resolver discovery 落回 "none"，
 * 永远不去找 app 的 Electron 二进制——WorkBuddy 5.6 起凭据文件是加密的，
 * 解密必须临时拉起 app 自己的二进制取 at-rest key，于是 wbai 永远
 * not_signed_in。CN 的 app（5.3.8）凭据还是明文踩不到这条链，一旦 CN
 * 客户端升级到 5.6.2+ 同样会挂，所以两个变体都要传。
 *
 * 定位方式：扫包内 lib 目录，按函数名 + 函数体引用的类名匹配（tsdown
 * 产物保留可读符号，插件升级换 chunk 文件名也不受影响）；不实际调用
 * 任何导出函数。结果按模块缓存，两个变体共用一次扫描。
 */
let keyProviderFactory;

async function loadKeyProviderFactory() {
  if (keyProviderFactory !== undefined) return keyProviderFactory;
  const libDirs = [
    path.resolve(HERE, '..', '..', 'node_modules', 'dsh-workbuddy-connect', 'lib'),
    path.resolve(HERE, '..', '..', 'shims', 'node_modules', 'dsh-workbuddy-connect', 'lib'),
  ];
  let lastErr;
  for (const dir of libDirs) {
    let files;
    try {
      files = fs.readdirSync(dir);
    } catch (e) {
      lastErr = e;
      continue;
    }
    for (const file of files) {
      // bin.js 是 CLI 入口，import 可能有副作用；其余都是纯协议层 chunk
      if (!file.endsWith('.js') || file === 'bin.js') continue;
      let mod;
      try {
        mod = await import(pathToFileURL(path.join(dir, file)).href);
      } catch (e) {
        lastErr = e;
        continue;
      }
      for (const value of Object.values(mod)) {
        if (typeof value !== 'function' || value.name !== 'atRestKeyProviderFor') continue;
        if (!Function.prototype.toString.call(value).includes('WorkBuddyAtRestKeyProvider')) continue;
        keyProviderFactory = value;
        return keyProviderFactory;
      }
    }
  }
  throw new Error(
    `无法在 dsh-workbuddy-connect 包内定位 atRestKeyProviderFor（未从包根导出，` +
      `凭据解密必需）：${lastErr?.message ?? lastErr}`,
  );
}

/**
 * 从凭据算账号键（visibility / probe / catalog 都按它分桶）。纯函数，不做 IO。
 *
 * 刻意比插件的 visibilityAccountOf 更严：它只判 `uid === ""`，于是
 * `{ enterpriseId: 'e1' }` 这种 uid 缺失的凭据会算出 `"undefined:e1"` —— 一个
 * 真值字符串，让所有缺 uid 的账号悄悄共用一个桶。源注释明说这种情况就该
 * "完全没有按账号的偏好"（宁可没有，也不能把一个账号的隐藏列表套到另一个上）。
 * 所以这里把 uid 缺失/空串一律判为"没有账号"。
 */
function accountKeyFromCredential(credential) {
  if (credential === undefined || credential === null) return undefined;
  if (typeof credential.uid !== 'string' || credential.uid === '') return undefined;
  return wb.visibilityAccountOf(credential);
}

/**
 * 清掉指向不存在文件的 WORKBUDDY(_AI)_ELECTRON_BIN。
 *
 * 插件对**显式配置的路径是"只信不退回"**的（resolveElectronPath 的注释：
 * "an explicit path is used as-is and never falls back"）：变量设了但那个文件不
 * 在，就直接抛 electron-path-invalid，连它自己的注册表/默认路径发现都不走。
 * 于是"配错一个变量"比"什么都不配"更糟——整条通道静默失效。
 *
 * 实测踩过这条：CN 客户端从 5.3.8 升到 5.6 时安装目录由 `D:\WorkBuddy` 换成了
 * `D:\workbuddyAI`，而这个变量还指着老路径，国内版从此全挂；更难受的是报错里
 * 提到的变量在注册表、shell profile、DSH 配置里都搜不到（是在某个控制台会话里
 * 临时设的），只能顺着错误信息一路翻。
 *
 * 所以在装配前做一次卫生检查：路径不存在就丢掉变量并明确告警，让插件的发现
 * 逻辑接手。只动本进程的环境，不改用户的运行环境。
 *
 * @returns {string|undefined} 被丢弃的那条失效路径（供调用方/测试观察）
 */
export function dropStaleElectronBin(envVar) {
  const configured = process.env[envVar]?.trim();
  if (configured === undefined || configured === '') return undefined;
  let usable = false;
  try {
    usable = fs.statSync(configured).isFile();
  } catch {
    usable = false;
  }
  if (usable) return undefined;
  delete process.env[envVar];
  logger.warn(
    `${envVar} 指向的路径不存在（${configured}），已忽略该设置、改用插件自身的发现逻辑；` +
      '客户端确实装在别处的话，请更新或删除这个环境变量',
  );
  return configured;
}

/**
 * @param {'cn'|'global'} variantId
 */
export async function createWorkBuddyProvider(variantId) {
  const variant = variantId === 'global' ? wb.AI_VARIANT : wb.CN_VARIANT;
  const fallback = variantId === 'global' ? wb.FALLBACK_WORKBUDDY_AI_MODELS : wb.FALLBACK_WORKBUDDY_MODELS;
  const prefs = createChannelPrefs({ channel: 'workbuddy', variant: variantId });

  // 失效的显式路径会让整条通道失效（见 dropStaleElectronBin 的说明）
  dropStaleElectronBin(variant.electron?.envVar);

  // 原插件 apply() 同款（index.js:2094）：keyProvider 对两个变体都传。
  const atRestKeyProviderFor = await loadKeyProviderFactory();
  const client = new wb.WorkBuddyUpstreamClient();
  const store = new wb.WorkBuddyCredentialStore({
    variant,
    keyProvider: atRestKeyProviderFor(variant),
    refresh: (credential) => client.refreshToken(credential),
  });
  const catalog = new wb.WorkBuddyCatalog(fallback);
  // 最大上下文开关（源语义：仅国际变体支持，默认开）。改动走面板写操作，
  // 持久化在偏好文件里，启动时恢复。
  const maximumContextEnabled = () => {
    const saved = prefs.get().useMaximumContextWindow;
    if (variantId === 'global') return saved === undefined ? true : saved === true;
    return saved === true;
  };
  if (variant.id !== wb.CN_VARIANT.id) catalog.setUseMaximumContextWindow(maximumContextEnabled());
  // 插件默认不可见，发现成功后才 setVisible(true)；独立网关直接暴露
  catalog.setVisible(true);

  // 探针同意（源 config.probeConsent，默认关）：开启后探针服务的自动探测被授权。
  const probeConsentEnabled = () => prefs.get().probeConsent === true;

  // 目录缓存（源 createVariantRuntime 同款装配）。路径刻意落在 local-relay 自己的
  // 状态目录：DSH 插件用同名文件写 ~/.dsh，而 store 的 persist() 是全量覆盖写，
  // 两个进程同时跑会互相把对方的改动整段抹掉。
  const savedCatalogs = new wb.WorkBuddyCatalogStore({
    path: statePath(`catalog.${variantId}.json`),
  });

  // 模型启停偏好按账号持久化（源 createVariantRuntime 同款装配），路径同样隔离。
  // 与 catalog store 相反：写失败会抛异常（源实现刻意不改内存态，
  // 免得磁盘与内存不一致而谎报成功）。
  const visibility = new wb.WorkBuddyVisibilityStore({
    path: statePath(`visibility.${variantId}.json`),
  });

  /** 目录来源（面板要能说明这批模型是哪来的） */
  let catalogSource = { source: 'fallback' };
  /** 上次成功/尝试拉取的时刻（sweep 的陈旧目录重试用） */
  let lastFetchAtMs = 0;

  /**
   * 账号键缓存。
   *
   * 必须是**同步**读取，因为 WorkBuddyProbeService 把它当 Map 键用、并做
   * `account() !== account` 的恒等比较（源 index.js:1071/1100/1116）。传异步函数
   * 会让两次调用返回两个不同的 Promise，恒等比较永远为真，探测就永远报
   * "account changed before detection"。
   *
   * 所以照插件的做法：异步解析一次凭据后把身份存下来，之后同步读。
   */
  let cachedAccount;

  /** 异步刷新账号键缓存，返回最新的键 */
  const refreshAccount = async () => {
    try {
      cachedAccount = accountKeyFromCredential(await store.resolve());
    } catch {
      cachedAccount = undefined;
    }
    return cachedAccount;
  };

  /** 同步读账号键（未解析过时为 undefined） */
  const account = () => cachedAccount;

  // 推理探针（源 createVariantRuntime 同款装配）。会真发上游请求并消耗额度，
  // 因此必须守住 consent 语义。
  const probeStore = new wb.WorkBuddyProbeStore({
    pluginVersion: 'local-relay/0.1.0',
    path: statePath(`probe.${variantId}.json`),
  });
  const probeService = new wb.WorkBuddyProbeService({
    store: probeStore,
    catalog,
    credentials: store,
    client,
    // 面板可开关（偏好 probeConsent，默认关）；手动点击始终走一次性同意
    consent: () => probeConsentEnabled(),
    account,
  });

  return {
    id: variant.id,
    label: variant.displayName,
    providerPrefix: variantId === 'global' ? 'workbuddy-ai' : 'workbuddy',
    shim: null,
    // 供面板查询（只读；响应体经面板层过滤，不含 token）
    store,
    client,
    savedCatalogs,
    visibility,
    probeStore,
    probeService,
    account,
    prefs,
    catalogSource: () => ({ ...catalogSource }),
    /** 最大上下文开关当前值（面板展示与切换用） */
    maximumContext: {
      supported: variant.id !== wb.CN_VARIANT.id,
      get: maximumContextEnabled,
      set(value) {
        if (variant.id === wb.CN_VARIANT.id) {
          return { state: 'failed', reason: 'maximum context window is not supported for the CN variant' };
        }
        prefs.patch({ useMaximumContextWindow: value === true });
        catalog.setUseMaximumContextWindow(value === true);
        return { state: 'updated', enabled: value === true };
      },
    },
    /** 探针同意开关 */
    probeConsent: {
      get: probeConsentEnabled,
      set(value) {
        prefs.patch({ probeConsent: value === true });
        return { state: 'updated', enabled: value === true };
      },
    },
    /** 模型启停（与 Qoder 同构：全局黑名单，wholesale 替换） */
    setModelsEnabled({ models, enabled }) {
      const disabled = new Set(
        Array.isArray(prefs.get().disabledModels) ? prefs.get().disabledModels : [],
      );
      for (const id of models) {
        if (enabled) disabled.delete(id);
        else disabled.add(id);
      }
      prefs.patch({ disabledModels: [...disabled] });
      return { state: 'updated', disabledModels: [...disabled] };
    },
    /** 清空全部探针记录（源语义：card 的显式 clear 动作 = 全账号清空） */
    clearProbe() {
      probeStore.clear();
      return { state: 'cleared' };
    },
    async logout() {
      await store.logout();
      return { state: 'updated' };
    },

    async start() {
      // 先解析一次凭据，把账号键缓存填上（探针的同步 account() 依赖它）
      await refreshAccount();

      // 再试上次保存的目录，让重启后的头几秒就有真实模型可用
      const saved = savedCatalogs.get(account());
      if (saved !== undefined && Array.isArray(saved.models) && saved.models.length > 0) {
        catalog.set(saved.models);
        catalogSource = {
          source: 'saved',
          ...(saved.fetchedAtMs === undefined ? {} : { fetchedAtMs: saved.fetchedAtMs }),
          ...(saved.appVersion === undefined ? {} : { appVersion: saved.appVersion }),
        };
      }

      const shim = wb.createWorkBuddyShim({ store, client, catalog, logger });
      await shim.ready;
      this.shim = shim;
      await this.refreshModels();
      return this;
    },

    async refreshModels() {
      // 单飞：并发调用共享一次拉取（源 fetchCatalog 的 in-flight 语义）
      if (this._inflightFetch !== undefined) return this._inflightFetch;
      const run = (async () => {
        const errors = [];
        try {
          const credential = await store.resolve();
          await refreshAccount();
          const models = await client.fetchModels(credential);
          if (Array.isArray(models) && models.length > 0) {
            catalog.set(models);
            catalogSource = { source: 'live', fetchedAtMs: Date.now() };
            // 落盘供下次启动使用（写失败被 store 吞掉，源行为）
            const key = account();
            if (key !== undefined) {
              savedCatalogs.set(key, {
                source: 'workbuddy:catalog',
                fetchedAtMs: Date.now(),
                models,
                ...(client.lastCatalog?.appVersion?.version === undefined
                  ? {}
                  : { appVersion: client.lastCatalog.appVersion.version }),
              });
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
     * 凭据 sweep（源 syncVariant 语义）：账号变化 → 重拉目录；
     * 目录仍非实时且距上次拉取超过 10 个周期 → 自动重试一次（失败的目录
     * 不能因为启动时一次网络抖动就永远停在兜底名册上）。
     */
    startSweep() {
      if (this._sweepTimer !== undefined) return;
      let lastSeenAccount;
      const pollMs = Number(process.env.RELAY_WB_POLL_MS) || 30_000;
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

    /**
     * 对话服务目录：按当前账号的可见性偏好过滤（源语义——隐藏的模型
     * 不对 DSH 提供）。此前只写偏好不过滤，"隐藏"实际没生效。
     * 另外叠加全局停用列表（与 Qoder 同构的面板启停开关）。
     */
    models() {
      const rows = catalog.current();
      const disabledModels = Array.isArray(prefs.get().disabledModels) ? prefs.get().disabledModels : [];
      let hidden = [];
      try {
        const key = account();
        if (key !== undefined) {
          hidden = visibility.disabled(key);
        }
      } catch { /* 偏好读不到就不过滤 */ }
      return visibleModels(rows, { disabledModels, hidden });
    },
    /** 面板展示用全量目录（含已隐藏），否则隐藏后行消失、无法再显示 */
    displayModels() {
      return catalog.current();
    },
    async close() {
      if (this._sweepTimer !== undefined) clearInterval(this._sweepTimer);
      await this.shim?.close();
    },
  };
}
