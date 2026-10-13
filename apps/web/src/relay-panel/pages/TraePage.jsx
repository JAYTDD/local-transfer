import React, { useEffect, useState } from 'react';
import { Select } from 'antd';
import ChannelLayout from '../components/ChannelLayout.jsx';
import CreditsPanel from '../components/CreditsPanel.jsx';
import ModelTable from '../components/ModelTable.jsx';
import { CopyButton, Disclosure, EmptyState, LoadingBlock, Notice, Section, StatusPill, Switch, fmtCtx, fmtNum, fmtTime } from '../components/primitives.jsx';
import { AlertIcon, CalendarCheckIcon, PlaneIcon, RefreshIcon } from '../components/icons.jsx';
import { api } from '../api.js';
import { useAsyncData } from '../hooks.js';

const REGIONS = [
  { key: 'cn', label: '国内版' },
  { key: 'ai', label: '国际版' },
];

const PROBE_LABEL = {
  available: '可用',
  gated: '需付费',
  unsupported: '不提供',
  rate_limited: '限流',
  auth: '登录失效',
  unknown: '未能判断',
};

function expiryNotice(expiry) {
  if (!expiry) return null;
  if (expiry.expired?.packs > 0) {
    return { kind: 'err', text: `有 ${expiry.expired.packs} 笔共 ${fmtNum(expiry.expired.total)} 积分已过期，但余额还在` };
  }
  const soon = expiry.within24h?.packs > 0
    ? { bucket: expiry.within24h, label: '24 小时内' }
    : expiry.within3d?.packs > 0
      ? { bucket: expiry.within3d, label: '3 天内' }
      : expiry.within7d?.packs > 0
        ? { bucket: expiry.within7d, label: '7 天内' }
        : null;
  if (!soon) return null;
  const when = soon.bucket.earliestExpiresAtMs ? `，最早 ${fmtTime(soon.bucket.earliestExpiresAtMs)}` : '';
  return { kind: 'info', text: `有 ${soon.bucket.packs} 笔共 ${fmtNum(soon.bucket.total)} 积分将在${soon.label}到期${when}` };
}

function planLabel(pay) {
  if (!pay) return null;
  const tier = typeof pay.payIdentityStr === 'string' ? pay.payIdentityStr.trim() : '';
  if (tier) return pay.inTrial ? `${tier} · 试用中` : tier;
  if (pay.hasPackage) return '已订阅';
  if (pay.inTrial) return '试用中';
  return 'Free';
}

/** Trae 通道页：登录态、账号切换、额度、签到、选集/预算、Raw Chat 诊断 */
export default function TraePage({ region, onRegion, onChannelChanged }) {
  const { data, loading, error, reload, mutate } = useAsyncData(
    (signal) => api.getTrae(region, signal),
    { cacheKey: `trae:${region}` },
  );
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null); // {kind, text}
  const [pendingToggle, setPendingToggle] = useState(null);
  const [probes, setProbes] = useState({});
  useEffect(() => { setProbes({}); }, [region]);

  const doc = data?.regions?.[region];
  const prefs = doc?.prefs ?? {};

  async function control(action, okText) {
    setBusy(true);
    setNotice(null);
    try {
      const out = await api.postTraeControl(region, action);
      setNotice(out?.state === 'updated' || out?.state === 'cleared'
        ? { kind: 'ok', text: okText ?? '已保存' }
        : { kind: 'err', text: `操作失败：${out?.reason ?? out?.state ?? '未知原因'}` });
      await reload();
      onChannelChanged?.();
      return out;
    } catch (e) {
      setNotice({ kind: 'err', text: `操作失败：${e.message ?? e}` });
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function refresh() {
    setBusy(true);
    setNotice(null);
    try {
      const out = await api.postTraeRefresh(region);
      const errs = (out?.errors ?? []).filter(Boolean);
      setNotice(errs.length > 0
        ? { kind: 'err', text: `目录已更新，但有告警：${errs.join('；')}` }
        : { kind: 'ok', text: `目录已更新（${(out?.models ?? []).length} 个模型）` });
      await reload();
      onChannelChanged?.();
    } catch (e) {
      setNotice({ kind: 'err', text: `刷新失败：${e.message ?? e}` });
    } finally {
      setBusy(false);
    }
  }

  async function testModels(ids) {
    setBusy(true);
    setNotice(null);
    try {
      const out = await api.postTraeControl(region, { action: 'test-models', models: ids });
      if (out?.state !== 'updated') {
        setNotice({ kind: 'err', text: `测试失败：${out?.reason ?? out?.state ?? '未知原因'}` });
        return;
      }
      const next = {};
      for (const row of out.results ?? []) next[row.id] = row;
      setProbes(next);
      const bad = (out.results ?? []).filter((row) => row.verdict !== 'available').length;
      setNotice({
        kind: bad > 0 ? 'info' : 'ok',
        text: `已测试 ${out.results?.length ?? 0} 个模型${bad > 0 ? `，${bad} 个不是可用` : ''}`,
      });
    } catch (e) {
      setNotice({ kind: 'err', text: `测试失败：${e.message ?? e}` });
    } finally {
      setBusy(false);
    }
  }

  async function checkin() {
    setBusy(true);
    try {
      const out = await api.postTraeCheckin(region);
      setNotice(out?.claimed
        ? { kind: 'ok', text: `签到成功${typeof out.message === 'string' && out.message ? `：${out.message}` : ''}` }
        : { kind: 'info', text: `未领取：${out?.reason ?? '今日已签或活动未开启'}` });
      await reload();
      onChannelChanged?.();
    } catch (e) {
      setNotice({ kind: 'err', text: `签到失败：${e.message ?? e}` });
    } finally {
      setBusy(false);
    }
  }

  const signedIn = doc?.status === 'signed-in';
  const lapsing = expiryNotice(doc?.credits?.expiry);
  const deviceCheckedElsewhere = doc?.checkin?.didCheckedIn === true && doc?.checkin?.checkedIn !== true;
  const channelEnabled = prefs.enabled !== false;
  // 模型选集语义（源）：空集 = 全部启用。切换时按全集展开，避免"空集关掉一个变成全关"。
  const allIds = (doc?.models ?? []).map((m) => m.id);
  const effectiveEnabled = new Set(prefs.modelSelection?.length ? prefs.modelSelection : allIds);
  const effectiveImage = new Set(prefs.imageSelection ?? []);

  /** 本地补丁该区域的 prefs 字段（乐观更新与回滚共用） */
  const patchPrefs = (fields) => mutate((current) => ({
    ...current,
    regions: {
      ...current.regions,
      [region]: {
        ...(current.regions?.[region] ?? {}),
        prefs: { ...(current.regions?.[region]?.prefs ?? {}), ...fields },
      },
    },
  }));

  /** 模型启用：乐观更新，点击立即生效；失败才回滚并提示，避免整页跳动 */
  async function toggleModel(id, enabled) {
    const previous = prefs.modelSelection;
    const next = new Set(effectiveEnabled);
    if (enabled) next.add(id);
    else next.delete(id);
    // 全关时退回空集（源语义：空选集 = 全要），避免整条通道悄悄失能
    const ids = next.size === 0 ? [] : [...next];
    const modelSelection = ids.length === allIds.length ? [] : ids;
    patchPrefs({ modelSelection });
    setNotice(null);
    setPendingToggle(`model:${id}`);
    try {
      const out = await api.postTraeControl(region, { action: 'set-model-selection', models: modelSelection });
      if (out?.state !== 'updated') {
        patchPrefs({ modelSelection: previous });
        setNotice({ kind: 'err', text: `操作失败：${out?.reason ?? out?.state ?? '未知原因'}` });
        return;
      }
      onChannelChanged?.();
    } catch (e) {
      patchPrefs({ modelSelection: previous });
      setNotice({ kind: 'err', text: `操作失败：${e.message ?? e}` });
    } finally {
      setPendingToggle(null);
    }
  }

  /** 上下文只允许切到该模型公布的 Max 窗口。null 表示回到默认档。 */
  async function chooseContext(id, maxWindow) {
    const previous = prefs.contextBudgets ?? {};
    const next = { ...previous };
    if (typeof maxWindow === 'number') next[id] = maxWindow;
    else delete next[id];
    patchPrefs({ contextBudgets: next });
    setNotice(null);
    setPendingToggle(`ctx:${id}`);
    try {
      const out = await api.postTraeControl(region, { action: 'set-context-budgets', budgets: next });
      if (out?.state !== 'updated') {
        patchPrefs({ contextBudgets: previous });
        setNotice({ kind: 'err', text: `操作失败：${out?.reason ?? out?.state ?? '未知原因'}` });
        return;
      }
      onChannelChanged?.();
    } catch (e) {
      patchPrefs({ contextBudgets: previous });
      setNotice({ kind: 'err', text: `操作失败：${e.message ?? e}` });
    } finally {
      setPendingToggle(null);
    }
  }

  /** 图片输入：乐观更新，点击立即生效；失败才回滚并提示，避免整页跳动 */
  async function toggleImage(id, enabled) {
    const previous = prefs.imageSelection;
    const next = new Set(effectiveImage);
    if (enabled) next.add(id);
    else next.delete(id);
    const imageSelection = [...next];
    patchPrefs({ imageSelection });
    setNotice(null);
    setPendingToggle(`image:${id}`);
    try {
      const out = await api.postTraeControl(region, { action: 'set-image-selection', models: imageSelection });
      if (out?.state !== 'updated') {
        patchPrefs({ imageSelection: previous });
        setNotice({ kind: 'err', text: `操作失败：${out?.reason ?? out?.state ?? '未知原因'}` });
        return;
      }
      onChannelChanged?.();
    } catch (e) {
      patchPrefs({ imageSelection: previous });
      setNotice({ kind: 'err', text: `操作失败：${e.message ?? e}` });
    } finally {
      setPendingToggle(null);
    }
  }

  return (
    <ChannelLayout
      icon={<PlaneIcon size={22} />}
      title="Trae"
      sub="字节跳动订阅 · 国内版支持签到与积分明细，国际版只回报订阅状态"
      regions={REGIONS}
      region={region}
      onRegion={onRegion}
      statusNode={doc && <StatusPill ok={signedIn} label={signedIn ? '已登录' : '未登录'} title={doc.reason} />}
      actions={(
        <button type="button" className="btn" disabled={busy || !doc} onClick={refresh}>
          <RefreshIcon size={14} /> 刷新目录
        </button>
      )}
    >
      {loading && !doc && <div className="section"><LoadingBlock lines={4} tall /></div>}
      {error && !doc && <Notice kind="err">{error}</Notice>}

      {doc && !channelEnabled && (
        <Notice kind="info">
          该区域已在下方设置中停用：模型不出现在 /v1/models，调用会被拒绝。
        </Notice>
      )}
      {doc && !signedIn && (
        <Section>
          <EmptyState
            icon={<AlertIcon size={20} />}
            title={`Trae ${region === 'cn' ? '国内版' : '国际版'}未登录`}
            sub={`在本机对应的 Trae 客户端里登录一次即可，网关会直接复用它的登录态。${doc.reason ? `（${doc.reason}）` : ''}`}
          />
          {doc.searched?.length > 0 && (
            <Disclosure summary={`凭据扫描详情（${doc.searched.length} 个位置）`}>
              <ul className="mono-list">
                {doc.searched.map((s, i) => (
                  <li key={i}>{s.path}<span className="reason"> — {s.reason}{s.message ? `：${s.message}` : ''}</span></li>
                ))}
              </ul>
            </Disclosure>
          )}
        </Section>
      )}

      {doc && signedIn && (
        <>
          {notice && <Notice kind={notice.kind}>{notice.text}</Notice>}
          {doc.appLogin && (
            <Notice kind="info">
              Trae 已登录 {doc.appLogin.accountName}，网关绑定的是 {doc.accountName ?? '另一个账号'}。
              <button
                type="button"
                className="btn sm"
                style={{ marginLeft: 8 }}
                disabled={busy}
                onClick={() => control({ action: 'select-account', accountId: doc.appLogin.id }, `已改用 ${doc.appLogin.accountName}`)}
              >
                改用 {doc.appLogin.accountName}
              </button>
            </Notice>
          )}
          {lapsing && <Notice kind={lapsing.kind}>{lapsing.text}</Notice>}

          <Section title="额度" actions={doc.accountName && <span className="section-hint">账号 <code className="inline">{doc.accountName}</code>{doc.tokenExpiresAtMs && <> · 令牌到期 {fmtTime(doc.tokenExpiresAtMs)}</>}</span>}>
            {/* 多账号时给出切换（源 accounts.{cn,ai} 选择语义；选择持久化在网关侧） */}
            {doc.accounts?.length > 1 && (
              <div className="setting-row" style={{ marginBottom: 12 }}>
                <span className="desc">使用账号</span>
                {doc.accounts.map((a) => (
                  <button
                    key={a.id}
                    type="button"
                    className={`btn sm ${a.selected ? 'primary' : ''}`}
                    disabled={busy || a.selected}
                    onClick={() => control({ action: 'select-account', accountId: a.id }, `已切换到 ${a.accountName}`)}
                  >
                    {a.accountName}{a.selected ? ' ✓' : ''}
                  </button>
                ))}
              </div>
            )}
            {region === 'cn' ? (
              <CreditsPanel
                metrics={[
                  { label: '剩余额度', value: fmtNum(doc.credits?.available), hero: true },
                  { label: '已使用', value: fmtNum(doc.credits?.consumed) },
                  { label: 'Work 通道可用', value: fmtNum(doc.credits?.workAvailable) },
                  { label: '通用通道可用', value: fmtNum(doc.credits?.generalAvailable) },
                ]}
                packs={(doc.credits?.accounts ?? []).filter((p) => p.remain > 0).map((p) => ({
                  name: p.displayDesc,
                  remain: p.remain,
                  size: p.size,
                  note: p.expiresAtMs ? `到期 ${fmtTime(p.expiresAtMs)}` : undefined,
                }))}
                error={doc.creditsError}
                unavailable={doc.usageUnavailable ? `额度信息不可用（${doc.usageUnavailable}）` : undefined}
              />
            ) : (
              <CreditsPanel
                metrics={doc.payStatus ? [{ label: '套餐', value: planLabel(doc.payStatus), hero: true }] : []}
                unavailable={doc.payStatus ? '国际版按套餐计费，上游不提供积分明细' : undefined}
                error={doc.payStatusError}
              />
            )}

            {region === 'cn' && doc.checkin && (
              <div className="endpoint" style={{ marginTop: 14 }}>
                <CalendarCheckIcon size={16} style={{ color: 'var(--accent)' }} />
                <span className="meta">
                  签到：<strong style={{ color: 'var(--text)' }}>{doc.checkin.checkedIn ? '今日已签' : deviceCheckedElsewhere ? '本设备今日已签，这个账号还没领到' : '今日未签'}</strong>
                  {typeof doc.checkin.credits === 'number' && doc.checkin.credits > 0 && ` · 可领 ${doc.checkin.credits} 积分`}
                  {doc.checkin.enabled === false && ' · 活动未开启'}
                </span>
                <span style={{ flex: 1 }} />
                <button
                  type="button"
                  className="btn primary sm"
                  disabled={busy || doc.checkin.checkedIn || doc.checkin.didCheckedIn || doc.checkin.enabled === false}
                  onClick={checkin}
                >
                  {doc.checkin.checkedIn ? '已领取' : deviceCheckedElsewhere ? '本设备已用过' : '领取签到奖励'}
                </button>
              </div>
            )}
          </Section>

          <Section
            title="模型"
            count={`${(doc.models ?? []).length}`}
            hint={<span className="section-hint">有 Max 档的模型可在默认窗口和最大窗口之间选。测试会逐个发一次短请求，消耗少量积分。</span>}
            actions={(
              <>
                <button
                  type="button"
                  className="btn sm"
                  disabled={busy || effectiveEnabled.size === 0}
                  onClick={() => testModels([...effectiveEnabled])}
                >
                  测试已启用
                </button>
                <button
                  type="button"
                  className="btn sm"
                  disabled={busy || allIds.length === 0}
                  onClick={() => testModels(allIds)}
                >
                  测试全部
                </button>
              </>
            )}
          >
            <ModelTable
              models={doc.models}
              columns={[
                {
                  key: 'ctx',
                  label: '上下文',
                  render: (m) => {
                    const dev = m.contextWindow;
                    const max = m.maxContextWindow;
                    if (typeof max !== 'number' || max <= (dev ?? 0)) return fmtCtx(dev) ?? '—';
                    const usingMax = prefs.contextBudgets?.[m.id] === max;
                    return (
                      <Select
                        size="small"
                        aria-label={`上下文 ${m.id}`}
                        value={usingMax ? 'max' : 'dev'}
                        disabled={busy || pendingToggle === `ctx:${m.id}`}
                        popupMatchSelectWidth={false}
                        style={{ minWidth: 108 }}
                        onChange={(value) => chooseContext(m.id, value === 'max' ? max : null)}
                        options={[
                          { value: 'dev', label: fmtCtx(dev) ?? '默认' },
                          { value: 'max', label: `${fmtCtx(max)} Max` },
                        ]}
                      />
                    );
                  },
                },
                {
                  key: 'probe',
                  label: '测试',
                  render: (m) => {
                    const row = probes[m.id];
                    if (!row) return '—';
                    const label = PROBE_LABEL[row.verdict] ?? row.verdict;
                    return <span title={row.detail || undefined}>{label}</span>;
                  },
                },
                { key: 'rate', label: '倍率', numeric: true, render: (m) => (typeof m.creditMultiplier === 'number' ? `x${m.creditMultiplier}` : '—') },
                {
                  key: 'img',
                  label: '图片',
                  render: (m) => (
                    <Switch
                      checked={effectiveImage.has(m.id)}
                      disabled={busy || pendingToggle === `image:${m.id}`}
                      label={`图片输入 ${m.id}`}
                      onChange={(on) => toggleImage(m.id, on)}
                    />
                  ),
                },
                {
                  key: 'enabled',
                  label: '启用',
                  render: (m) => (
                    <Switch
                      checked={effectiveEnabled.has(m.id)}
                      disabled={busy || pendingToggle === `model:${m.id}`}
                      label={`启用 ${m.id}`}
                      onChange={(on) => toggleModel(m.id, on)}
                    />
                  ),
                },
              ]}
            />
          </Section>

          <Disclosure summary="通道设置与诊断">
            <div className="setting-row">
              <div className="grow">
                <div>启用该区域</div>
                <div className="desc">关闭后 Trae {region === 'cn' ? '国内版' : '国际版'}的模型不再出现在 /v1/models，调用返回 404</div>
              </div>
              <Switch
                checked={channelEnabled}
                disabled={busy}
                label="启用该区域"
                onChange={(on) => control({ action: 'set-enabled', enabled: on }, on ? '区域已启用' : '区域已停用')}
              />
            </div>
            {doc.rawChat && (
              <p className="small dim" style={{ margin: 0 }}>
                Raw Chat 网关（CN）：{doc.rawChat.state ?? '未知'}{doc.rawChat.reason ? ` · ${doc.rawChat.reason}` : ''}
                {doc.rawChat.state !== 'enabled' && doc.rawChat.state !== 'available' ? '（不可用时自动走原生 SOLO 通道）' : ''}
              </p>
            )}
            <button type="button" className="btn sm" disabled={busy} onClick={() => control({ action: 'logout' }, '已清除网关保存的凭据副本')}>
              清除凭据副本（logout）
            </button>
          </Disclosure>
        </>
      )}
    </ChannelLayout>
  );
}
