/**
 * Trae 面板数据层。
 *
 * 原插件的 /plugins/dsh-connect-trae/usage 由 traeWebUsage(deps, region) 组装，
 * deps 需要 store / client / displayModels / enabledModelIds / regionEnabled /
 * discoverModels / rawDiagnostic 一整套服务。
 *
 * local-relay 的 provider 暴露了 { store, region, models(), refreshModels() }。
 * 本模块据此给出**真实**的登录态与账号信息（只读，不含 token）：
 *   - 登录态：store.status() → { state, edition, expiresAtMs, source }
 *   - 账号：  store.accounts() → [{ id, accountName, edition, region, tokenExpiresAtMs, selected }]
 *   - 额度/签到：需要 TraeUsageClient（未装配），因此明确留空而非编造。
 *
 * 注意：早期版本一律返回 signed-out，导致已登录的 Trae CN 被误报为"未登录"。
 * 面板必须反映真实状态，不能凭"依赖不全"就声称未登录。
 */
import { withDeadline } from './live-deadline.mjs';

const REGIONS = ['cn', 'ai'];

const PREFIX_BY_REGION = { cn: 'trae', ai: 'traeg' };

function providerFor(providers, region) {
  return providers.find((p) => p.def.prefix === PREFIX_BY_REGION[region]);
}

/** Raw Chat 网关诊断（源 rawDiagnostic 同款；仅 CN 装配，未装配时如实报告） */
function toRawChat(provider) {
  const diagnostic = provider?.rawDiagnostic?.();
  return diagnostic === undefined ? { state: 'not-wired' } : diagnostic;
}

/** 归一化模型行 */
function toModelRow(m) {
  return {
    id: m.id,
    name: m.name ?? m.id,
    ...(m.contextWindow === undefined ? {} : { contextWindow: m.contextWindow }),
    ...(m.maxTokens === undefined ? {} : { maxTokens: m.maxTokens }),
    ...(Array.isArray(m.input) ? { input: m.input } : {}),
    ...(typeof m.creditMultiplier === 'number' ? { creditMultiplier: m.creditMultiplier } : {}),
  };
}

/**
 * 额度快照 → 面板字段。
 *
 * 形状照抄源实现（trae:3823 `toCredits`）：snapshot 是嵌套的，
 * summary 给总量，packs 按 availableEndpoint 分成 work(1) 与 general(0) 两块可用额度。
 * 不做白名单裁剪——这里映射出的字段本身已是受控集合。
 */
export function toCredits(snapshot) {
  const round = (value) => Math.round(value * 1e4) / 1e4;
  const totalAmount = snapshot?.summary?.totalAmount ?? 0;
  const consumedAmount = snapshot?.summary?.consumedAmount ?? 0;
  const packs = Array.isArray(snapshot?.packs) ? snapshot.packs : [];
  const remaining = (endpoint) =>
    packs
      .filter((pack) => pack.availableEndpoint === endpoint)
      .reduce((sum, pack) => round(sum + Math.max(0, (pack.creditsLimit ?? 0) - (pack.consumedCredits ?? 0))), 0);
  return {
    total: totalAmount,
    consumed: consumedAmount,
    available: totalAmount - consumedAmount,
    workAvailable: remaining(1),
    generalAvailable: remaining(0),
    accounts: packs.map((pack) => ({
      displayDesc: pack.displayDesc,
      remain: round(Math.max(0, (pack.creditsLimit ?? 0) - (pack.consumedCredits ?? 0))),
      size: pack.creditsLimit ?? 0,
    })),
  };
}

/** 签到状态 → 面板字段（形状照抄源实现 trae:3842 `toCheckin`） */
export function toCheckin(raw) {
  const extra = raw?.extraCredits;
  return {
    checkedIn: raw?.checkedIn === true,
    didCheckedIn: raw?.didCheckedIn === true,
    credits: typeof raw?.credits === 'number' ? raw.credits : 0,
    enabled: raw?.enabled !== false,
    ...(typeof extra === 'number' && extra > 0 ? { extraCredits: extra } : {}),
  };
}

/** 未配置该区域时的文档 */
export function unconfiguredDocument(region) {
  return {
    status: 'signed-out',
    region,
    enabled: false,
    accounts: [],
    models: [],
    enabledModelIds: [],
    reason: `region not configured: ${region}`,
  };
}

export function createTraeStatus({ providers }) {
  return {
    regions() {
      return [...REGIONS];
    },

    /**
     * 总览用的纯本地摘要：登录态走 store.status()（本地凭据扫描），不发上游请求；
     * 区域启停由 healthDocument 的 enabled 字段表达，这里不重复。
     */
    async summary(region) {
      const entry = providerFor(providers(), region);
      if (!entry) return { status: 'signed-out', reason: `region not configured: ${region}` };
      if (!entry.provider) return { status: 'failed', reason: entry.error ?? 'provider unavailable' };
      let auth = { state: 'signed-out' };
      try {
        if (entry.provider.store) auth = (await entry.provider.store.status()) ?? auth;
      } catch (e) {
        return { status: 'failed', reason: String(e?.message ?? e) };
      }
      const out = { status: auth.state === 'signed-in' ? 'signed-in' : 'signed-out' };
      if (out.status !== 'signed-in' && auth.reason !== undefined) out.reason = auth.reason;
      return out;
    },

    async document(region) {
      const entry = providerFor(providers(), region);
      if (!entry) return unconfiguredDocument(region);

      // provider 启动失败时 entry.provider 为 null；此时仍要返回结构完整的文档
      const liveProvider = entry.provider;
      const models = (liveProvider?.models?.() ?? entry.models ?? []).map(toModelRow);
      const store = liveProvider?.store;

      if (!liveProvider) {
        return {
          ...unconfiguredDocument(region),
          enabled: false,
          models,
          enabledModelIds: models.map((m) => m.id),
          ...(entry.error === undefined ? {} : { reason: entry.error }),
        };
      }

      // 查询真实登录态；任何异常都退化为 signed-out 但带上原因
      let statusDoc = { state: 'signed-out' };
      let accounts = [];
      let searched = [];
      let reason;
      try {
        if (store) {
          statusDoc = (await store.status()) ?? { state: 'signed-out' };
          accounts = await store.accounts();
          // 面板要能回答"为什么没登录"：列出扫描过的凭据位置。
          // 只暴露 path/edition/source/reason（源 traeWebUsage 的 signed-out 分支同款）。
          if (statusDoc.state !== 'signed-in' && typeof store.diagnose === 'function') {
            try {
              const { failures } = await store.diagnose();
              searched = (failures ?? []).map((f) => ({
                path: f.path,
                edition: f.edition,
                source: f.source,
                reason: f.reason,
                ...(f.message === undefined ? {} : { message: String(f.message).slice(0, 200) }),
              }));
            } catch { /* 诊断失败不影响文档 */ }
          }
        } else {
          reason = 'credential store not wired';
        }
      } catch (e) {
        reason = String(e?.message ?? e);
      }

      const signedIn = statusDoc.state === 'signed-in';
      const selected = accounts.find((a) => a.selected) ?? accounts[0];

      // 额度/签到：CN 与 AI 是两条不同的上游契约（源实现只在 ai 走 payStatus）。
      // 任何异常降级成 *Error 字段，绝不让整个文档 500；真上游读走面板的等待预算
      // （上游卡住时只丢这一段，模型与设置照常出）。
      let usageFields = {};
      const usage = liveProvider.usage;
      if (!signedIn) {
        usageFields = {};
      } else if (!usage) {
        usageFields = { usageUnavailable: 'usage client not wired' };
      } else if (region === 'ai') {
        try {
          usageFields = { payStatus: await withDeadline(usage.payStatus(), 'Trae 订阅状态') };
        } catch (e) {
          usageFields = { payStatusError: String(e?.message ?? e) };
        }
      } else {
        const [snapshotResult, checkinResult] = await Promise.allSettled([
          withDeadline(usage.snapshot(), 'Trae 额度'),
          withDeadline(usage.checkinStatus(), 'Trae 签到状态'),
        ]);
        usageFields = {
          ...(snapshotResult.status === 'fulfilled'
            ? { credits: toCredits(snapshotResult.value) }
            : { creditsError: String(snapshotResult.reason?.message ?? snapshotResult.reason) }),
          ...(checkinResult.status === 'fulfilled'
            ? { checkin: toCheckin(checkinResult.value) }
            : { checkinError: String(checkinResult.reason?.message ?? checkinResult.reason) }),
        };
      }

      return {
        status: signedIn ? 'signed-in' : 'signed-out',
        region,
        enabled: true,
        ...(signedIn ? {} : { reason: reason ?? statusDoc.reason ?? 'no credential' }),
        ...(statusDoc.reasonCode === undefined ? {} : { reasonCode: statusDoc.reasonCode }),
        accounts,
        ...(searched.length > 0 ? { searched } : {}),
        ...(selected
          ? {
              accountId: selected.id,
              accountName: selected.accountName,
              tokenExpiresAtMs: selected.tokenExpiresAtMs,
            }
          : {}),
        ...usageFields,
        // 面板管理需要全部模型（选集只影响对话），display 语义 = 只剔死模型
        models: liveProvider.displayModels?.() ?? models,
        enabledModelIds: models.map((m) => m.id),
        // 通道偏好与诊断（源卡片的设置面/诊断面）
        prefs: {
          enabled: liveProvider.enabled?.() ?? true,
          selectedAccountId: liveProvider.prefs?.get().selectedAccountId,
          modelSelection: liveProvider.prefs?.get().enabledModelIds ?? [],
          imageSelection: liveProvider.prefs?.get().imageModelIds ?? [],
          contextBudgets: liveProvider.prefs?.get().contextBudgets ?? {},
        },
        rawChat: toRawChat(liveProvider),
      };
    },

    /**
     * 面板写操作（源插件由 DSH 设置面持久化的那些字段）。
     * 语义照抄：账号切换 = store.selectAccount；选集 = 空数组"全要"；
     * 区域关闭 = 提供方整体下线（路由层从 /v1/models 剔除）。
     */
    async control(region, action) {
      const entry = providerFor(providers(), region);
      if (!entry) return { state: 'failed', reason: `trae region not configured: ${region}` };
      const provider = entry.provider;
      if (!provider) return { state: 'failed', reason: entry.error ?? 'provider unavailable' };
      switch (action?.action) {
        case 'select-account':
          if (typeof action.accountId !== 'string') {
            return { state: 'failed', reason: 'select-account requires accountId' };
          }
          return provider.selectAccount(action.accountId);
        case 'set-enabled':
          return provider.setEnabled(action.enabled === true);
        case 'set-model-selection':
          if (!Array.isArray(action.models)) return { state: 'failed', reason: 'set-model-selection requires models' };
          return provider.setModelSelection(action.models);
        case 'set-image-selection':
          if (!Array.isArray(action.models)) return { state: 'failed', reason: 'set-image-selection requires models' };
          return provider.setImageSelection(action.models);
        case 'set-context-budgets':
          if (action.budgets === undefined || typeof action.budgets !== 'object' || Array.isArray(action.budgets)) {
            return { state: 'failed', reason: 'set-context-budgets requires budgets object' };
          }
          return provider.setContextBudgets(action.budgets);
        case 'logout':
          return provider.logout();
        default:
          return { state: 'failed', reason: `unknown action: ${String(action?.action)}` };
      }
    },

    /**
     * 领取今日签到奖励。本数据层唯一的写操作。
     *
     * 守卫顺序照抄源实现（registerTraeUsageRoute 的 checkin 分支）：先读 checkinStatus，
     * 再决定要不要写。上游按北京日期幂等（重复领取返回 code:0 而额度不变），但我们不依赖
     * 这一点——"不会重复发放"是需要验证的上游性质，不是可以指望的保证。
     *
     * 业务拒绝以 HTTP 200 + 非零 code 返回（最常见 9004 = 请求没带 x-device-id），
     * 那种情况报 claimed:false 而非抛错，好让调用方区分"上游拒绝"与"请求没到达"。
     */
    async checkin(region) {
      const entry = providerFor(providers(), region);
      if (!entry) return { state: 'failed', reason: `trae region not configured: ${region}` };
      if (region !== 'cn') {
        return { state: 'failed', reason: 'check-in is only available for the CN region' };
      }
      const usage = entry.provider?.usage;
      if (!usage) return { state: 'failed', reason: 'action not wired yet: checkin (needs usage client)' };

      // 先读：已签 / 未开启都不该再打写接口
      let status;
      try {
        status = await usage.checkinStatus();
      } catch (e) {
        return { state: 'failed', reason: `checkin status unavailable: ${String(e?.message ?? e)}` };
      }
      if (status?.enabled === false) {
        return { state: 'updated', claimed: false, reason: 'check-in is not enabled for this account' };
      }
      if (status?.checkedIn === true) {
        return { state: 'updated', claimed: false, reason: 'already checked in today' };
      }
      if (status?.didCheckedIn === true) {
        return { state: 'updated', claimed: false, reason: 'already checked in from this device today' };
      }

      try {
        const out = await usage.claimCheckin();
        return {
          state: 'updated',
          claimed: out.claimed === true,
          code: out.code,
          message: out.message,
        };
      } catch (e) {
        return { state: 'failed', reason: String(e?.message ?? e) };
      }
    },

    async refresh(region) {
      const entry = providerFor(providers(), region);
      if (!entry) throw new Error(`trae region not configured: ${region}`);
      const out = await entry.provider.refreshModels();
      entry.models = entry.provider.models();
      return { models: out.models ?? entry.models, errors: out.errors ?? [] };
    },
  };
}
