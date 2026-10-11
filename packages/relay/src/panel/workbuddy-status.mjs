/**
 * WorkBuddy 面板数据层。
 *
 * 原插件 /plugins/dsh-workbuddy-connect/status 由 workBuddyWebStatus(deps) 组装，
 * deps 需要 store / client / models / catalog / visibility / probe / probeKey 等。
 * local-relay 的 provider 目前只保证 models() / refreshModels() 可用，
 * 因此本模块：
 *   - 读：模型一律从 provider.models() 出（能列出模型即视为可用）；
 *   - 写：把原插件的 action 语义映射到本进程可执行的操作（refresh 走 refreshModels，
 *     其余动作需要探针/可见性持久化，未装配时返回 failed 并说明原因，
 *     绝不静默成功——静默成功正是 proxy-hub 踩过的坑）。
 */
import { normalizeCredits, modelWithCurrentPromotion } from 'dsh-workbuddy-connect';
import { withDeadline } from './live-deadline.mjs';

const VARIANTS = { cn: 'wb', global: 'wbai' };

function providerFor(providers, variant) {
  const prefix = VARIANTS[variant];
  if (!prefix) return undefined;
  return providers.find((p) => p.def.prefix === prefix);
}

/** 归一化模型行：补上 credits 显示串，剥掉原始 billing */
export function toModelRow(model) {
  // 促销按当前时间重算（源 modelWithCurrentPromotion）：
  // 缓存的"夜间免费"之类标签过期后自动消失、费率自动回落，不必等下一次刷新。
  // 注意该函数只接受一个参数，且无活跃促销时原样返回同一个对象。
  const live = modelWithCurrentPromotion(model);
  // normalizeCredits 是字符串归一化（'x0.79 credits' → 'x0.79'），与 DSH 面板显示一致
  const rate = normalizeCredits(live.billing?.credits);
  return {
    id: live.id,
    name: live.name ?? live.id,
    ...(live.billing?.free === true ? { free: true } : {}),
    ...(Array.isArray(live.billing?.badges) && live.billing.badges.length > 0 ? { badges: live.billing.badges } : {}),
    ...(rate === undefined ? {} : { credits: rate }),
    ...(live.billing?.rateUnknown === true ? { rateUnknown: true } : {}),
    ...(typeof live.contextWindow === 'number' && live.contextWindow > 0 ? { contextWindow: live.contextWindow } : {}),
    ...(typeof live.maxTokens === 'number' && live.maxTokens > 0 ? { maxTokens: live.maxTokens } : {}),
  };
}

export function createWorkBuddyStatus({ providers }) {
  return {
    variants() {
      return Object.keys(VARIANTS);
    },

    /**
     * 总览用的纯本地摘要：与 document 同一套登录态基准（全量目录非空即视为
     * 可用——把模型全部隐藏不该被误报成"未登录"），不碰额度、不刷新目录。
     */
    async summary(variant) {
      const entry = providerFor(providers(), variant);
      if (!entry) return { status: 'signed-out', reason: `variant not configured: ${variant}` };
      if (!entry.provider) return { status: 'failed', reason: entry.error ?? 'provider unavailable' };
      const live = entry.provider;
      const models = live.displayModels?.() ?? live.models?.() ?? entry.models ?? [];
      const out = { status: models.length > 0 ? 'signed-in' : 'signed-out' };
      if (out.status === 'signed-out') out.reason = 'no models discovered';
      if (live.catalogSource?.().source === 'fallback') {
        out.degraded = true;
        out.reason = out.reason ?? '目录为内置兜底（实时拉取未成功过）';
      }
      return out;
    },

    async document(variant) {
      const entry = providerFor(providers(), variant);
      if (!entry) {
        return { status: 'signed-out', reason: `variant not configured: ${variant}`, models: [] };
      }
      // provider 启动失败时 entry.provider 为 null
      const liveProvider = entry.provider;
      if (!liveProvider) {
        return {
          status: 'signed-out',
          variant,
          models: [],
          reason: entry.error ?? 'provider unavailable',
        };
      }
      // 面板展示全量目录（含已隐藏）；隐藏过滤只作用于对话服务（provider.models()）。
      // 用全量做登录态判定：把模型全部隐藏不该被误报成"未登录"。
      const models = (liveProvider.displayModels?.() ?? liveProvider.models?.() ?? entry.models ?? []).map(toModelRow);
      const signedIn = models.length > 0;

      // 目录来源（源 workBuddyWebStatus 的 catalogSection）：面板要能说明这批模型
      // 是实时拉的、还是上次存下来的。未装配时不显示，不编造。
      let catalogField = {};
      if (liveProvider.catalogSource) {
        const source = liveProvider.catalogSource() ?? {};
        const account = await liveProvider.account?.();
        const saved = account === undefined ? undefined : liveProvider.savedCatalogs?.get(account);
        catalogField = {
          catalog: {
            ...source,
            ...(saved?.appVersion === undefined ? {} : { appVersion: saved.appVersion }),
          },
        };
      }

      // 额度（源 workBuddyWebStatus 的 credits 段）：读不到就记 creditsError，
      // 模型列表照常可用；无凭据时安静跳过（不报错，也不编造）。
      // fetchCredits 返回 { total, accounts:[{packageName,remain,size}] }，本身不含凭据材料。
      // 真上游请求，走面板的等待预算：上游卡住时不让整页文档跟着卡（见 live-deadline）。
      let creditsField = {};
      try {
        const credential = await liveProvider.store?.current();
        if (credential !== undefined && liveProvider.client?.fetchCredits) {
          creditsField = { credits: await withDeadline(liveProvider.client.fetchCredits(credential), 'WorkBuddy 额度') };
        }
      } catch (e) {
        creditsField = { creditsError: String(e?.message ?? e) };
      }

      // 模型启停按账号维度读（源 workBuddyWebStatus 的 visibility 段）。
      // 读不到就不显示，不编造——空列表与"没隐藏任何模型"同义。
      let visibilityField = {};
      try {
        const account = await liveProvider.account?.();
        if (liveProvider.visibility && account !== undefined) {
          visibilityField = { visibility: { disabled: [...liveProvider.visibility.disabled(account)] } };
        }
      } catch { /* 读不到就不显示 */ }

      // 探针区（源 isProbeCandidate / probeSection 语义）：候选 = 支持推理但上游
      // 没声明 effort 集的模型。故意不按"已有结果"过滤——那样列表会越用越短，
      // 想重测一个得先清掉所有别的结果。
      let probeField = {};
      const probeService = liveProvider.probeService;
      if (probeService) {
        const all = liveProvider.models?.() ?? entry.models ?? [];
        const candidates = all
          .filter((m) => m.reasoning?.supports === true && (m.reasoning.supportedEfforts?.length ?? 0) === 0)
          .map((m) => m.id);
        const results = all.flatMap((m) => {
          const record = probeService.recordFor(m.id);
          return record === undefined
            ? []
            : [{
                id: m.id,
                name: m.name ?? m.id,
                validation: record.validation,
                efforts: record.efforts,
                probedAt: record.probedAtMs,
              }];
        });
        probeField = { probe: { running: probeService.isRunning(), candidates, results } };
      }

      return {
        status: signedIn ? 'signed-in' : 'signed-out',
        ...(signedIn ? {} : { reason: 'no models discovered' }),
        variant,
        ...catalogField,
        ...creditsField,
        ...visibilityField,
        ...probeField,
        models,
        disabledModels: Array.isArray(liveProvider.prefs?.get?.().disabledModels)
          ? liveProvider.prefs.get().disabledModels
          : [],
        // 设置面状态（源卡片的开关项）
        maximumContext: liveProvider.maximumContext
          ? { supported: liveProvider.maximumContext.supported, enabled: liveProvider.maximumContext.get() }
          : undefined,
        probeConsent: liveProvider.probeConsent?.get() ?? false,
      };
    },

    /**
     * 手动探测一个模型的推理 effort。
     *
     * manualConsent=true 是"一次性同意"：只授权这一次，不改变自动探测配置。
     * 这是真会发上游请求、可能消耗额度的操作，所以未装配时明确失败而不是假装成功。
     */
    async probe(variant, modelId) {
      const entry = providerFor(providers(), variant);
      if (!entry) return { state: 'failed', reason: `variant not configured: ${variant}` };
      if (!entry.provider) return { state: 'failed', reason: entry.error ?? 'provider unavailable' };
      if (typeof modelId !== 'string' || modelId === '') {
        return { state: 'failed', reason: 'probe requires a model id' };
      }
      const probeService = entry.provider.probeService;
      if (!probeService) {
        return { state: 'failed', reason: 'action not wired yet: probe (needs probe service)' };
      }
      try {
        return await probeService.probe(modelId, true);
      } catch (e) {
        return { state: 'failed', reason: String(e?.message ?? e) };
      }
    },

    async control(variant, action) {
      const entry = providerFor(providers(), variant);
      if (!entry) return { state: 'failed', reason: `variant not configured: ${variant}` };
      if (!entry.provider) return { state: 'failed', reason: entry.error ?? 'provider unavailable' };
      const kind = action?.action;
      if (kind === 'refresh') {
        try {
          const out = await entry.provider.refreshModels();
          entry.models = entry.provider.models();
          return { state: 'updated', models: out.models ?? entry.models, errors: out.errors ?? [] };
        } catch (e) {
          return { state: 'failed', reason: String(e?.message ?? e) };
        }
      }
      if (kind === 'set-models-enabled') {
        const models = Array.isArray(action.models)
          ? action.models.filter((m) => typeof m === 'string' && m.trim() !== '')
          : typeof action.model === 'string' && action.model.trim() !== ''
            ? [action.model.trim()]
            : [];
        if (models.length === 0) return { state: 'failed', reason: 'set-models-enabled requires model ids' };
        if (typeof entry.provider.setModelsEnabled !== 'function') {
          return { state: 'failed', reason: 'action not wired yet: set-models-enabled' };
        }
        try {
          return entry.provider.setModelsEnabled({ models, enabled: action.enabled === true });
        } catch (e) {
          return { state: 'failed', reason: String(e?.message ?? e) };
        }
      }
      if (kind === 'set-model-visibility') {
        const model = action?.model;
        if (typeof model !== 'string' || model === '') {
          return { state: 'failed', reason: 'set-model-visibility requires a model id' };
        }
        const visibility = entry.provider.visibility;
        if (!visibility) {
          return { state: 'failed', reason: 'action not wired yet: set-model-visibility (needs visibility store)' };
        }
        const account = await entry.provider.account?.();
        if (account === undefined) {
          return { state: 'failed', reason: 'set-model-visibility needs a signed-in account with a uid' };
        }
        try {
          // 源语义：visible=true 且这是最后一个被隐藏的模型时，整条账号记录被删除
          // （空列表与缺记录同义，文件不该攒空桶）。
          visibility.setVisible(account, model, action?.visible !== false);
          return { state: 'updated', visibility: { disabled: [...visibility.disabled(account)] } };
        } catch (e) {
          // 写失败必须报出去：源实现刻意不改内存态，吞掉会让状态与磁盘不一致
          return { state: 'failed', reason: String(e?.message ?? e) };
        }
      }
      if (kind === 'clear') {
        // 源语义：显式 clear 动作 = 清空全部账号的探针记录
        if (!entry.provider.clearProbe) {
          return { state: 'failed', reason: 'action not wired yet: clear (needs probe store)' };
        }
        return entry.provider.clearProbe();
      }
      if (kind === 'set-maximum-context-window') {
        return entry.provider.maximumContext.set(action.enabled === true);
      }
      if (kind === 'set-probe-consent') {
        return entry.provider.probeConsent.set(action.enabled === true);
      }
      if (kind === 'logout') {
        return entry.provider.logout();
      }
      return { state: 'failed', reason: `unknown action: ${String(kind)}` };
    },
  };
}
