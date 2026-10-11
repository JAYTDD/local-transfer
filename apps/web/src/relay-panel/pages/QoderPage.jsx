import React, { useState } from 'react';
import ChannelLayout from '../components/ChannelLayout.jsx';
import CreditsPanel from '../components/CreditsPanel.jsx';
import ModelTable from '../components/ModelTable.jsx';
import ProbeSection from '../components/ProbeSection.jsx';
import { Disclosure, EmptyState, LoadingBlock, Notice, Section, StatusPill, Switch, fmtCtx, fmtNum, fmtRate, fmtTime } from '../components/primitives.jsx';
import { AlertIcon, CalendarCheckIcon, RefreshIcon, TerminalIcon } from '../components/icons.jsx';
import { api } from '../api.js';
import { useAsyncData } from '../hooks.js';

const REGIONS = [
  { key: 'cn', label: '国内版' },
  { key: 'global', label: '国际版' },
];

const CATALOG_LABEL = { live: '实时拉取', saved: '上次保存的目录', fallback: '内置兜底名册' };
const CHECKIN_LABEL = {
  claimed: '今日已领',
  already_claimed: '今日已领',
  'already-claimed': '今日已领',
  available: '今日可领',
  'no-campaign': '今日无可领活动',
};

/** 分钟数 → UTC+8 的 HH:mm */
function minuteLabel(minute) {
  const h = Math.floor(minute / 60);
  const m = minute % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')} (UTC+8)`;
}

/** 今日（UTC+8）日期串，与后端调度器的判定一致 */
function beijingToday() {
  return new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 10);
}

/** 记录显示这些状态且是今天的 → 视为"今日已结算"，按钮禁用 */
const SETTLED_STATUSES = ['claimed', 'already-claimed', 'no-campaign'];

/** 上下文列：默认窗口，若有更大的可扩展窗口则以 200K / 1M 形式并列 */
function qoderCtx(m) {
  const def = fmtCtx(m.contextWindow);
  const max = fmtCtx(m.maxContextWindow);
  if (!def) return '—';
  return max && max !== def ? `${def} / ${max}` : def;
}

/** Qoder 通道页：额度、签到状态、推理探测、模型目录 */
export default function QoderPage({ variant, onVariant, onChannelChanged }) {
  const { data, loading, error, reload, mutate } = useAsyncData(
    (signal) => api.getQoder(variant, signal),
    { cacheKey: `qoder:${variant}` },
  );
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState(null);
  const [pendingModel, setPendingModel] = useState(null);

  const doc = data?.variants?.[variant];
  const configured = doc?.status === 'signed-in';

  async function refresh() {
    setBusy('刷新目录');
    setNotice(null);
    try {
      const out = await api.postQoderRefresh(variant);
      setNotice(out?.state === 'updated'
        ? { kind: 'ok', text: `目录已更新（${(out?.models ?? []).length} 个模型）` }
        : { kind: 'err', text: `刷新失败：${out?.reason ?? out?.state}` });
      await reload();
      onChannelChanged?.();
    } catch (e) {
      setNotice({ kind: 'err', text: `刷新失败：${e.message ?? e}` });
    } finally {
      setBusy('');
    }
  }

  async function probe(modelId) {
    setBusy(`探测 ${modelId}`);
    setNotice(null);
    try {
      const out = await api.postQoderProbe(variant, modelId);
      setNotice(out?.state === 'ok'
        ? { kind: 'ok', text: `探测 ${modelId} 完成：${out.validation}${out.efforts?.length ? `（${out.efforts.join('、')}）` : ''}` }
        : { kind: 'err', text: `探测 ${modelId} 未完成：${out?.reason ?? out?.state ?? '未知原因'}` });
      await reload();
    } catch (e) {
      setNotice({ kind: 'err', text: `探测 ${modelId} 失败：${e.message ?? e}` });
    } finally {
      setBusy('');
    }
  }

  async function control(action, okText) {
    setBusy(action.action ?? 'control');
    setNotice(null);
    try {
      const out = await api.postQoderControl(variant, action);
      const ok = out?.state === 'updated' || out?.state === 'cleared' || out?.state === 'claimed' || out?.state === 'already-claimed';
      setNotice(ok
        ? { kind: 'ok', text: okText ?? out?.reason ?? '已保存' }
        : { kind: 'err', text: `操作失败：${out?.reason ?? out?.state ?? '未知原因'}` });
      await reload();
      onChannelChanged?.();
      return out;
    } catch (e) {
      setNotice({ kind: 'err', text: `操作失败：${e.message ?? e}` });
      return null;
    } finally {
      setBusy('');
    }
  }

  /** 模型启停：乐观更新，点击立即生效；失败才回滚并提示，避免整页跳动 */
  async function toggleModel(id, enabled) {
    const previous = doc?.disabledModels ?? [];
    const next = enabled ? previous.filter((item) => item !== id) : [...new Set([...previous, id])];
    mutate((current) => ({
      ...current,
      variants: {
        ...current.variants,
        [variant]: { ...(current.variants?.[variant] ?? {}), disabledModels: next },
      },
    }));
    setNotice(null);
    setPendingModel(id);
    try {
      const out = await api.postQoderControl(variant, { action: 'set-models-enabled', models: [id], enabled });
      if (out?.state !== 'updated') {
        mutate((current) => ({
          ...current,
          variants: {
            ...current.variants,
            [variant]: { ...(current.variants?.[variant] ?? {}), disabledModels: previous },
          },
        }));
        setNotice({ kind: 'err', text: `操作失败：${out?.reason ?? out?.state ?? '未知原因'}` });
        return;
      }
      if (Array.isArray(out.disabledModels)) {
        mutate((current) => ({
          ...current,
          variants: {
            ...current.variants,
            [variant]: { ...(current.variants?.[variant] ?? {}), disabledModels: out.disabledModels },
          },
        }));
      }
      onChannelChanged?.();
    } catch (e) {
      mutate((current) => ({
        ...current,
        variants: {
          ...current.variants,
          [variant]: { ...(current.variants?.[variant] ?? {}), disabledModels: previous },
        },
      }));
      setNotice({ kind: 'err', text: `操作失败：${e.message ?? e}` });
    } finally {
      setPendingModel(null);
    }
  }

  /** 手动签到：结果按源状态语义给精确反馈（claimed/already-claimed/no-campaign/error） */
  async function claim() {
    setBusy('checkin');
    setNotice(null);
    try {
      const out = await api.postQoderControl(variant, { action: 'checkin' });
      if (out?.state === 'claimed') setNotice({ kind: 'ok', text: `签到成功${out?.amount ? `，+${out.amount} 算力` : ''}` });
      else if (out?.state === 'already-claimed') setNotice({ kind: 'info', text: '今日已领取过，明天再来' });
      else if (out?.state === 'no-campaign') setNotice({ kind: 'info', text: '今日没有可领取的签到活动' });
      else setNotice({ kind: 'err', text: `签到失败：${out?.reason ?? out?.state ?? '未知原因'}` });
      await reload();
      onChannelChanged?.();
    } catch (e) {
      setNotice({ kind: 'err', text: `签到失败：${e.message ?? e}` });
    } finally {
      setBusy('');
    }
  }

  const disabledModels = new Set(doc?.disabledModels ?? []);
  const log = doc?.checkInLog;
  const record = log?.checkin;
  // 源签到结果语义：claimed/already-claimed/no-campaign 都是"今天已结算"，
  // 只有 error 允许当天重试。此前移植丢了这条判定，按钮永远可点。
  const settled = Boolean(
    record && record.lastDate === beijingToday() && SETTLED_STATUSES.includes(record.lastStatus),
  );

  return (
    <ChannelLayout
      icon={<TerminalIcon size={22} />}
      title="Qoder"
      sub="上游模型 ID 是内部代号（qfmodel 等），调用时以 ID 为准"
      regions={REGIONS}
      region={variant}
      onRegion={onVariant}
      statusNode={doc && <StatusPill ok={configured} label={configured ? '已配置' : '未配置'} title={doc.reason} />}
      actions={(
        <button type="button" className="btn" disabled={busy !== '' || !configured} onClick={refresh}>
          <RefreshIcon size={14} /> 刷新目录
        </button>
      )}
    >
      {loading && !doc && <div className="section"><LoadingBlock lines={4} tall /></div>}
      {error && !doc && <Notice kind="err">{error}</Notice>}

      {doc && !configured && (
        <Section>
          <EmptyState
            icon={<AlertIcon size={20} />}
            title={`Qoder ${variant === 'cn' ? '国内版' : '国际版'}未配置`}
            sub={doc.reason ?? '未找到本机 Qoder 客户端的登录凭据'}
          />
        </Section>
      )}

      {doc && configured && (
        <>
          {notice && <Notice kind={notice.kind}>{notice.text}</Notice>}

          <Section title="额度">
            <CreditsPanel
              metrics={[
                { label: '可用额度', value: fmtNum(doc.credits?.total), hero: true },
                { label: '总额度', value: fmtNum(doc.credits?.totalSize) },
                ...(doc.credits?.unlimited === true ? [{ label: '计费模式', value: '不限量' }] : []),
              ]}
              packs={(doc.credits?.accounts ?? []).filter((p) => p.remain > 0).map((p) => ({ name: p.packageName, remain: p.remain, size: p.size }))}
              error={doc.creditsError}
            />
            {/* 不限量账号的周期重置是 9999-12-31，那是哨兵值不是真实日期，不展示 */}
            {doc.credits?.cycleResetTime && !String(doc.credits.cycleResetTime).startsWith('9999') && (
              <p className="small dim" style={{ margin: '10px 0 0' }}>
                周期重置：{String(doc.credits.cycleResetTime).slice(0, 10)}
              </p>
            )}
            {/* 签到：面板可手动领取（源 checkin 动作）；自动签到在下方设置里 */}
            <div className="endpoint" style={{ marginTop: 14 }}>
              <CalendarCheckIcon size={16} style={{ color: 'var(--accent)' }} />
              <span className="meta">
                签到：
                {record
                  ? <strong style={{ color: 'var(--text)' }}>{CHECKIN_LABEL[record.lastStatus] ?? record.lastStatus}</strong>
                  : <strong style={{ color: 'var(--text)' }}>今日未领</strong>}
                {typeof record?.amount === 'number' && record.amount > 0 && ` · ${record.amount} 算力`}
                {record?.lastDate && ` · ${record.lastDate}`}
                {log?.nextRunAt && ` · 下次自动 ${new Date(log.nextRunAt).toLocaleString('zh-CN', { hour12: false })}`}
              </span>
              <span style={{ flex: 1 }} />
              <button
                type="button"
                className="btn primary sm"
                disabled={busy !== '' || !configured || settled}
                onClick={claim}
              >
                {settled
                  ? (record.lastStatus === 'no-campaign' ? '今日无可领' : '今日已领')
                  : '立即领取'}
              </button>
            </div>
          </Section>

          <ProbeSection probe={doc.probe} busy={busy} onProbe={probe} />

          <Section
            title="模型"
            count={`${(doc.models ?? []).length}`}
            hint={<span className="section-hint">停用的模型不出现在 /v1/models，也无法调用</span>}
          >
            <ModelTable
              models={doc.models}
              rowClass={(m) => (disabledModels.has(m.id) ? 'row-off' : '')}
              columns={[
                { key: 'ctx', label: '上下文', numeric: true, render: qoderCtx },
                { key: 'reason', label: '推理', render: (m) => (m.isReasoning ? <span className="tag reasoning">{m.reasoningEfforts?.length ? m.reasoningEfforts.join('、') : '支持'}</span> : '—') },
                { key: 'img', label: '图片', render: (m) => (m.supportsImages ? '支持' : '—') },
                { key: 'rate', label: '倍率', numeric: true, render: (m) => fmtRate(m.credits) ?? '—' },
                {
                  key: 'enabled',
                  label: '启用',
                  render: (m) => (
                    <Switch
                      checked={!disabledModels.has(m.id)}
                      disabled={busy !== '' || pendingModel === m.id}
                      label={`启用 ${m.id}`}
                      onChange={(on) => toggleModel(m.id, on)}
                    />
                  ),
                },
              ]}
            />
          </Section>

          {(doc.pat || doc.catalog) && (
            <Disclosure summary="凭据与目录详情">
              {doc.pat && (
                <p className="small dim" style={{ margin: 0 }}>
                  凭据来源：{doc.pat.source ?? '未知'}
                  {doc.pat.patTail ? ` · 令牌尾号 ${doc.pat.patTail}` : ''}
                  {fmtTime(doc.pat.savedAtMs) ? ` · 保存于 ${fmtTime(doc.pat.savedAtMs)}` : ''}
                </p>
              )}
              {doc.catalog && (
                <p className="small dim" style={{ margin: 0 }}>
                  模型目录：{CATALOG_LABEL[doc.catalog.source] ?? doc.catalog.source}
                  {fmtTime(doc.catalog.fetchedAtMs) ? ` · ${fmtTime(doc.catalog.fetchedAtMs)}` : ''}
                  {doc.catalog.error ? ` · ${doc.catalog.error}` : ''}
                </p>
              )}
              {doc.filePath && <p className="small dim" style={{ margin: 0 }}>凭据文件：<code className="inline">{doc.filePath}</code></p>}
            </Disclosure>
          )}

          <Disclosure summary="通道设置">
            <div className="setting-row">
              <div className="grow">
                <div>最大上下文窗口</div>
                <div className="desc">上游声明多个窗口时选用最大的（源 useMaximumContextWindow，默认开）</div>
              </div>
              <Switch
                checked={doc.maximumContext?.enabled !== false}
                disabled={busy !== ''}
                label="最大上下文窗口"
                onChange={(on) => control({ action: 'set-maximum-context-window', enabled: on }, on ? '已启用最大上下文' : '已停用最大上下文')}
              />
            </div>
            <div className="setting-row">
              <div className="grow">
                <div>授权自动推理探测</div>
                <div className="desc">开启后探针服务可自动发上游请求（消耗额度）；关闭时仅手动逐个点击</div>
              </div>
              <Switch
                checked={doc.probeConsent === true}
                disabled={busy !== ''}
                label="授权自动推理探测"
                onChange={(on) => control({ action: 'set-probe-consent', enabled: on }, on ? '已授权自动探测' : '已关闭自动探测')}
              />
            </div>
            <div className="setting-row">
              <div className="grow">
                <div>自动签到</div>
                <div className="desc">
                  每日自动领取算力额度
                  {log?.nextRunAt ? ` · 下次 ${new Date(log.nextRunAt).toLocaleString('zh-CN', { hour12: false })}` : ''}
                </div>
              </div>
              <Switch
                checked={doc.autoCheckIn?.enabled === true}
                disabled={busy !== ''}
                label="自动签到"
                onChange={(on) => control({ action: 'set-auto-checkin', enabled: on }, on ? '已开启自动签到' : '已关闭自动签到')}
              />
            </div>
            <div className="setting-row">
              <div className="grow">
                <div>签到时刻</div>
                <div className="desc">当前 {minuteLabel(doc.autoCheckIn?.checkInMinute ?? 600)}（0–1439，自 UTC+8 午夜起）</div>
              </div>
              <input
                type="number"
                min="0"
                max="1439"
                defaultValue={doc.autoCheckIn?.checkInMinute ?? 600}
                key={`minute-${doc.autoCheckIn?.checkInMinute ?? 600}`}
                disabled={busy !== ''}
                onBlur={(e) => {
                  const v = Number(e.target.value);
                  // 非法值给即时反馈，不静默忽略（后端同款校验兜底）
                  if (!Number.isInteger(v) || v < 0 || v > 1439) {
                    setNotice({ kind: 'err', text: '签到时刻需为 0–1439 的整数' });
                    return;
                  }
                  if (v !== (doc.autoCheckIn?.checkInMinute ?? 600)) {
                    control({ action: 'set-checkin-minute', minute: v }, '签到时刻已保存');
                  }
                }}
                style={{
                  width: 96, background: 'var(--panel-2)', border: '1px solid var(--line)',
                  borderRadius: 6, color: 'var(--text)', padding: '4px 8px', font: '14px var(--mono)',
                }}
              />
            </div>
            <PatEditor
              busy={busy !== ''}
              onSave={(pat) => control({ action: 'save-pat', pat }, 'PAT 已保存并刷新目录')}
              onClear={() => control({ action: 'logout' }, '已登出并清除凭据副本')}
              clearLabel="登出并清除副本"
            />
          </Disclosure>
        </>
      )}
    </ChannelLayout>
  );
}

/** PAT 管理（源 auth 路由的 save/clear；保存前由后端 validateApiKey 校验） */
function PatEditor({ busy, onSave, onClear, clearLabel = '清除副本' }) {
  const [value, setValue] = useState('');
  return (
    <div className="setting-row" style={{ alignItems: 'flex-start' }}>
      <div className="grow">
        <div>手动录入 PAT</div>
        <div className="desc">本机客户端未登录时，可直接粘贴 Qoder Personal Access Token（保存前会向上游校验）</div>
        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <input
            type="password"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="qoder_pat_…"
            autoComplete="off"
            spellCheck={false}
            style={{
              flex: 1, background: 'var(--panel-2)', border: '1px solid var(--line)',
              borderRadius: 6, color: 'var(--text)', padding: '5px 10px', font: '14px var(--mono)',
            }}
          />
          <button
            type="button"
            className="btn sm primary"
            disabled={busy || value.trim() === ''}
            onClick={() => { onSave(value.trim()); setValue(''); }}
          >
            保存
          </button>
          <button type="button" className="btn sm" disabled={busy} onClick={onClear}>
            {clearLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
