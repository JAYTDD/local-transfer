/**
 * Qoder 面板数据层。
 *
 * 形状照抄源插件的 qoderWebStatus(deps)：
 *   - 登录态：store.status() → { state:'configured'|..., region, pat:{source,savedAtMs,patTail}, filePath }
 *   - 模型：modelSnapshot 的行（含 isReasoning、reasoningEfforts、supportsImages 等）
 *   - 额度：client.fetchCredits()（无参，与 WorkBuddy 不同）
 *   - 签到：client.checkIn()
 *   - 目录来源与探针：同另两个通道
 *
 * 早期版本这里是"未接入"占位，理由是 transport 未导出——那个结论是错的，
 * 详见 src/providers/qoder.mjs 顶部说明。
 */
import { normalizeCredits } from 'dsh-qoder-connect';
import { withDeadline } from './live-deadline.mjs';

const VARIANTS = { cn: 'qoder', global: 'qoderg' };

function providerFor(providers, variant) {
  const prefix = VARIANTS[variant];
  if (!prefix) return undefined;
  return providers.find((p) => p.def.prefix === prefix);
}

/**
 * 模型行 → 面板字段（照源 modelSnapshot）。
 * 只挑已知字段：上游多返什么都不漏进响应体。
 */
export function toModelRow(model) {
  const supported = Array.isArray(model.supportedContextWindows) ? model.supportedContextWindows : [];
  const maxContextWindow = supported.length > 0 ? Math.max(...supported) : undefined;
  const defaultContextWindow = model.defaultContextWindow ?? model.contextWindow;
  const rate = normalizeCredits(model.priceFactor ?? model.billing?.credits);
  return {
    id: model.id,
    name: model.name ?? model.id,
    ...(typeof model.contextWindow === 'number' && model.contextWindow > 0 ? { contextWindow: model.contextWindow } : {}),
    ...(typeof defaultContextWindow === 'number' && defaultContextWindow > 0 && defaultContextWindow < model.contextWindow
      ? { defaultContextWindow }
      : {}),
    ...(maxContextWindow === undefined || maxContextWindow <= defaultContextWindow ? {} : { maxContextWindow }),
    ...(model.reasoning?.supports === true ? { isReasoning: true } : {}),
    ...(Array.isArray(model.reasoning?.supportedEfforts) && model.reasoning.supportedEfforts.length > 0
      ? { reasoningEfforts: model.reasoning.supportedEfforts }
      : {}),
    ...(model.reasoning?.defaultEffort === undefined ? {} : { defaultReasoningEffort: model.reasoning.defaultEffort }),
    ...(rate === undefined ? {} : { credits: rate }),
    ...(model.supportsImages === undefined ? {} : { supportsImages: model.supportsImages }),
  };
}

export function createQoderStatus({ providers }) {
  return {
    variants() {
      return Object.keys(VARIANTS);
    },

    async document(variant) {
      const entry = providerFor(providers(), variant);
      if (!entry) {
        return { status: 'signed-out', variant, reason: `variant not configured: ${variant}`, models: [] };
      }
      // provider 启动失败时 entry.provider 为 null
      const live = entry.provider;
      if (!live) {
        return {
          status: 'signed-out',
          variant,
          models: [],
          reason: entry.error ?? 'provider unavailable',
        };
      }

      // 登录态（真实读取；不含原始 PAT——status() 只给 patTail/source/savedAtMs）
      let auth = { state: 'signed-out' };
      try {
        auth = (await live.store?.status()) ?? { state: 'signed-out' };
      } catch (e) {
        return { status: 'signed-out', variant, models: [], reason: String(e?.message ?? e) };
      }
      if (auth.state !== 'configured') {
        return {
          status: 'signed-out',
          variant,
          models: [],
          ...(auth.reason === undefined ? {} : { reason: auth.reason }),
        };
      }

      // 面板要展示全量目录（含已停用），否则停用的行消失后无法再启用；
      // current() 是源类语义（剔停用），只用于对话路由。
      const models = (live.displayModels?.() ?? live.models?.() ?? entry.models ?? []).map(toModelRow);

      // 目录来源
      let catalogField = {};
      if (live.catalogSource) {
        catalogField = { catalog: { ...(live.catalogSource() ?? {}) } };
      }

      // 额度（fetchCredits 无参）。真上游请求（内部 force 刷账号缓存），
      // 走面板的等待预算：上游卡住时只丢这一段，模型与设置照常出。
      let creditsField = {};
      try {
        if (live.client?.fetchCredits) {
          creditsField = { credits: await withDeadline(live.client.fetchCredits(), 'Qoder 额度') };
        }
      } catch (e) {
        creditsField = { creditsError: String(e?.message ?? e) };
      }

      // 签到：只读记录（源 status 路由读 JsonFileCheckInStore）。绝不因面板
      // 打开就调 client.checkIn()——那是领取动作（内部走 claimCampaign），
      // 旧版把 GET 变成了写操作，是审计时揪出的 bug。领取走 control 的 checkin。
      let checkInField = {};
      if (live.checkInStatus) checkInField = { checkIn: live.checkInStatus() };

      // 探针区（同 WorkBuddy 语义：候选 = 支持推理但上游未声明 effort 集）
      let probeField = {};
      const probeService = live.probeService;
      if (probeService) {
        const all = live.models?.() ?? entry.models ?? [];
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
        status: 'signed-in',
        variant,
        ...(auth.region === undefined ? {} : { region: auth.region }),
        // pat 只含 {source, savedAtMs, patTail}，是给人看的来源信息，不是密钥
        ...(auth.pat === undefined ? {} : { pat: auth.pat }),
        ...(auth.filePath === undefined ? {} : { filePath: auth.filePath }),
        ...catalogField,
        ...creditsField,
        ...checkInField,
        ...probeField,
        models,
        // 设置面状态（源卡片的开关项与签到调度）
        maximumContext: { enabled: live.prefs.get().useMaximumContextWindow !== false },
        probeConsent: live.prefs.get().probeConsent === true,
        disabledModels: live.prefs.get().disabledModels ?? [],
        modelContextWindows: live.prefs.get().modelContextWindows ?? {},
        autoCheckIn: {
          enabled: live.prefs.get().autoCheckIn === true,
          checkInMinute: live.prefs.get().checkInMinute ?? 600,
        },
        checkInLog: live.checkInStatus(),
      };
    },

    /**
     * 总览用的纯本地摘要：不发任何上游请求（额度/签到/目录刷新都不碰），
     * 只读本地凭据状态与目录来源标记。字段刻意收窄：status/reason/degraded。
     */
    async summary(variant) {
      const entry = providerFor(providers(), variant);
      if (!entry) return { status: 'signed-out', reason: `variant not configured: ${variant}` };
      if (!entry.provider) return { status: 'failed', reason: entry.error ?? 'provider unavailable' };
      let auth = { state: 'signed-out' };
      try {
        auth = (await entry.provider.store?.status()) ?? auth;
      } catch (e) {
        return { status: 'failed', reason: String(e?.message ?? e) };
      }
      const out = { status: auth.state === 'configured' ? 'signed-in' : 'signed-out' };
      if (out.status !== 'signed-in' && auth.reason !== undefined) out.reason = auth.reason;
      if (entry.provider.catalogSource?.().source === 'fallback') {
        out.degraded = true;
        out.reason = out.reason ?? '目录为内置兜底（实时拉取未成功过）';
      }
      return out;
    },

    /**
     * 面板写操作（源 probe-route 的 action 面 + 签到调度设置）。
     * 未装配的能力明确失败，绝不静默成功。
     */
    async control(variant, action) {
      const entry = providerFor(providers(), variant);
      if (!entry) return { state: 'failed', reason: `variant not configured: ${variant}` };
      if (!entry.provider) return { state: 'failed', reason: entry.error ?? 'provider unavailable' };
      const provider = entry.provider;
      switch (action?.action) {
        case 'checkin':
          return provider.checkIn();
        case 'clear-checkin-logs':
          return provider.clearCheckInLogs();
        case 'clear':
          return provider.clearProbe();
        case 'set-maximum-context-window':
          return provider.setMaximumContextWindow(action.enabled === true);
        case 'set-models-enabled': {
          const models = Array.isArray(action.models)
            ? action.models.filter((m) => typeof m === 'string' && m.trim() !== '')
            : typeof action.model === 'string' && action.model.trim() !== ''
              ? [action.model.trim()]
              : [];
          if (models.length === 0) return { state: 'failed', reason: 'set-models-enabled requires model ids' };
          return provider.setModelsEnabled({ models, enabled: action.enabled === true });
        }
        case 'set-model-context-windows':
          if (action.windows === undefined || typeof action.windows !== 'object' || Array.isArray(action.windows)) {
            return { state: 'failed', reason: 'set-model-context-windows requires windows object' };
          }
          return provider.setModelContextWindows(action.windows);
        case 'set-probe-consent':
          return provider.setProbeConsent(action.enabled === true);
        case 'set-auto-checkin':
          return provider.setAutoCheckIn(action.enabled === true);
        case 'set-checkin-minute':
          return provider.setCheckInMinute(action.minute);
        case 'save-pat':
          return provider.savePat(action.pat);
        case 'clear-pat':
          return provider.clearPat();
        case 'logout':
          return provider.logout();
        default:
          return { state: 'failed', reason: `unknown action: ${String(action?.action)}` };
      }
    },

    /** 手动探测一个模型的推理 effort（会真发上游请求并消耗额度） */
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

    /** 刷新模型目录 */
    async refresh(variant) {
      const entry = providerFor(providers(), variant);
      if (!entry) return { state: 'failed', reason: `variant not configured: ${variant}` };
      if (!entry.provider) return { state: 'failed', reason: entry.error ?? 'provider unavailable' };
      try {
        const out = await entry.provider.refreshModels();
        entry.models = entry.provider.models();
        return { state: 'updated', models: out.models ?? entry.models, errors: out.errors ?? [] };
      } catch (e) {
        return { state: 'failed', reason: String(e?.message ?? e) };
      }
    },
  };
}
