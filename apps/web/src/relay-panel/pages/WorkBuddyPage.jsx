import React, { useState } from 'react';
import ChannelLayout from '../components/ChannelLayout.jsx';
import CreditsPanel from '../components/CreditsPanel.jsx';
import ModelTable from '../components/ModelTable.jsx';
import ProbeSection from '../components/ProbeSection.jsx';
import { Disclosure, EmptyState, LoadingBlock, Notice, Section, StatusPill, Switch, fmtCtx, fmtNum, fmtRate, fmtTime } from '../components/primitives.jsx';
import { AlertIcon, BriefcaseIcon, RefreshIcon } from '../components/icons.jsx';
import { api } from '../api.js';
import { useAsyncData } from '../hooks.js';

const REGIONS = [
  { key: 'cn', label: '国内版' },
  { key: 'global', label: '国际版' },
];

const CATALOG_LABEL = { live: '实时拉取', saved: '上次保存的目录', fallback: '内置兜底名册' };

/** WorkBuddy 通道页：额度、模型启停、推理探测 */
export default function WorkBuddyPage({ variant, onVariant, onChannelChanged }) {
  const { data, loading, error, reload, mutate } = useAsyncData(
    (signal) => api.getWorkBuddy(variant, signal),
    { cacheKey: `workbuddy:${variant}` },
  );
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState(null);
  const [pendingModel, setPendingModel] = useState(null);

  const doc = data?.variants?.[variant];
  const signedIn = doc?.status === 'signed-in';
  const disabled = new Set(doc?.disabledModels ?? []);

  async function control(action, label, okText) {
    setBusy(label);
    setNotice(null);
    try {
      const out = await api.postWorkBuddyControl(variant, action);
      setNotice(out?.state === 'updated'
        ? { kind: 'ok', text: okText ?? `${label}成功` }
        : { kind: 'err', text: `${label}失败：${out?.reason ?? out?.state ?? '未知原因'}` });
      await reload();
      onChannelChanged?.();
    } catch (e) {
      setNotice({ kind: 'err', text: `${label}失败：${e.message ?? e}` });
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
      const out = await api.postWorkBuddyControl(variant, {
        action: 'set-models-enabled',
        models: [id],
        enabled,
      });
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

  async function refresh() {
    setBusy('刷新目录');
    setNotice(null);
    try {
      const out = await api.postWorkBuddyControl(variant, { action: 'refresh' });
      const errs = (out?.errors ?? []).filter(Boolean);
      setNotice(errs.length > 0
        ? { kind: 'err', text: `目录已更新，但有告警：${errs.join('；')}` }
        : { kind: 'ok', text: `目录已更新（${(out?.models ?? []).length} 个模型）` });
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
      const out = await api.postWorkBuddyProbe(variant, modelId);
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

  async function clearProbe() {
    setBusy('清空探针');
    setNotice(null);
    try {
      const out = await api.postWorkBuddyControl(variant, { action: 'clear' });
      setNotice(out?.state === 'cleared'
        ? { kind: 'ok', text: '已清空全部探针记录' }
        : { kind: 'err', text: `清空失败：${out?.reason ?? out?.state}` });
      await reload();
    } catch (e) {
      setNotice({ kind: 'err', text: `清空失败：${e.message ?? e}` });
    } finally {
      setBusy('');
    }
  }

  async function setSetting(action, okText) {
    setBusy(action.action);
    setNotice(null);
    try {
      const out = await api.postWorkBuddyControl(variant, action);
      setNotice(out?.state === 'updated'
        ? { kind: 'ok', text: okText }
        : { kind: 'err', text: `设置失败：${out?.reason ?? out?.state}` });
      await reload();
      onChannelChanged?.();
    } catch (e) {
      setNotice({ kind: 'err', text: `设置失败：${e.message ?? e}` });
    } finally {
      setBusy('');
    }
  }

  return (
    <ChannelLayout
      icon={<BriefcaseIcon size={22} />}
      title="WorkBuddy"
      sub="CodeBuddy 体系订阅 · 模型启停全局持久化"
      regions={REGIONS}
      region={variant}
      onRegion={onVariant}
      statusNode={doc && <StatusPill ok={signedIn} label={signedIn ? '已登录' : '未登录'} title={doc.reason} />}
      actions={(
        <button
          type="button"
          className="btn"
          disabled={busy !== '' || !doc}
          onClick={refresh}
        >
          <RefreshIcon size={14} /> 刷新目录
        </button>
      )}
    >
      {loading && !doc && <div className="section"><LoadingBlock lines={4} tall /></div>}
      {error && !doc && <Notice kind="err">{error}</Notice>}

      {doc && !signedIn && (
        <Section>
          <EmptyState
            icon={<AlertIcon size={20} />}
            title={`WorkBuddy ${variant === 'cn' ? '国内版' : '国际版'}不可用`}
            sub={doc.reason ?? '未发现可用凭据或模型目录为空'}
          />
        </Section>
      )}

      {doc && signedIn && (
        <>
          {notice && <Notice kind={notice.kind}>{notice.text}</Notice>}

          <Section
            title="额度"
            hint={doc.catalog && (
              <span className="section-hint">
                模型目录：{CATALOG_LABEL[doc.catalog.source] ?? doc.catalog.source}
                {doc.catalog.appVersion ? ` · app ${doc.catalog.appVersion}` : ''}
                {fmtTime(doc.catalog.fetchedAtMs) ? ` · ${fmtTime(doc.catalog.fetchedAtMs)}` : ''}
              </span>
            )}
          >
            <CreditsPanel
              metrics={[
                { label: '剩余总额', value: fmtNum(doc.credits?.total), hero: true },
                {
                  label: '有效额度包',
                  value: doc.credits
                    ? `${(doc.credits.accounts ?? []).filter((p) => p.remain > 0).length} / ${(doc.credits.accounts ?? []).length}`
                    : null,
                },
              ]}
              packs={(doc.credits?.accounts ?? []).filter((p) => p.remain > 0).map((p) => ({ name: p.packageName, remain: p.remain, size: p.size }))}
              error={doc.creditsError}
            />
          </Section>

          <ProbeSection
            probe={doc.probe}
            busy={busy}
            onProbe={probe}
            extraAction={(
              <button type="button" className="btn sm" disabled={busy !== ''} onClick={clearProbe}>
                清空记录
              </button>
            )}
          />

          <Section
            title="模型"
            count={`${(doc.models ?? []).length}${disabled.size > 0 ? ` · 已停用 ${disabled.size}` : ''}`}
            hint={<span className="section-hint">停用的模型不出现在 /v1/models，也无法调用</span>}
          >
            <ModelTable
              models={doc.models}
              rowClass={(m) => (disabled.has(m.id) ? 'row-off' : '')}
              columns={[
                { key: 'rate', label: '倍率', numeric: true, render: (m) => fmtRate(m.credits) ?? (m.rateUnknown ? '未知' : '—') },
                { key: 'free', label: '计费', render: (m) => (m.free ? <span className="tag free">免费</span> : '—') },
                { key: 'ctx', label: '上下文', numeric: true, render: (m) => fmtCtx(m.contextWindow) ?? '—' },
                { key: 'badges', label: '标签', render: (m) => (m.badges?.length ? <span className="tag">{m.badges.join('、')}</span> : '—') },
                {
                  key: 'enabled',
                  label: '启用',
                  render: (m) => (
                    <Switch
                      checked={!disabled.has(m.id)}
                      disabled={busy !== '' || pendingModel === m.id}
                      label={`启用 ${m.id}`}
                      onChange={(on) => toggleModel(m.id, on)}
                    />
                  ),
                },
              ]}
            />
          </Section>

          <Disclosure summary="通道设置与诊断">
            {doc.maximumContext?.supported && (
              <div className="setting-row">
                <div className="grow">
                  <div>最大上下文窗口</div>
                  <div className="desc">上游声明多个窗口时选用最大的（源 useMaximumContextWindow，默认开）</div>
                </div>
                <Switch
                  checked={doc.maximumContext.enabled !== false}
                  disabled={busy !== ''}
                  label="最大上下文窗口"
                  onChange={(on) => setSetting({ action: 'set-maximum-context-window', enabled: on }, on ? '已启用最大上下文' : '已停用最大上下文')}
                />
              </div>
            )}
            <div className="setting-row">
              <div className="grow">
                <div>授权自动推理探测</div>
                <div className="desc">开启后探针服务可自动发上游请求（消耗额度）；关闭时仅手动逐个点击</div>
              </div>
              <Switch
                checked={doc.probeConsent === true}
                disabled={busy !== ''}
                label="授权自动推理探测"
                onChange={(on) => setSetting({ action: 'set-probe-consent', enabled: on }, on ? '已授权自动探测' : '已关闭自动探测')}
              />
            </div>
            <button
              type="button"
              className="btn sm"
              disabled={busy !== ''}
              onClick={() => setSetting({ action: 'logout' }, '已清除网关保存的凭据副本')}
            >
              清除凭据副本（logout）
            </button>
          </Disclosure>
        </>
      )}
    </ChannelLayout>
  );
}
