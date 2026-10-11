import React from 'react';
import { CopyButton } from '../components/primitives.jsx';
import { BriefcaseIcon, ChevronRightIcon, GaugeIcon, GlobeIcon, PlaneIcon, TerminalIcon } from '../components/icons.jsx';

/** 三大订阅产品与它们的两个区服前缀 */
const PRODUCTS = [
  { key: 'trae', name: 'Trae', sub: '字节跳动 · 订阅额度', Icon: PlaneIcon, page: 'trae', regions: [{ key: 'cn', label: '国内版', prefix: 'trae' }, { key: 'ai', label: '国际版', prefix: 'traeg' }] },
  { key: 'workbuddy', name: 'WorkBuddy', sub: 'CodeBuddy 体系 · 订阅额度', Icon: BriefcaseIcon, page: 'workbuddy', regions: [{ key: 'cn', label: '国内版', prefix: 'wb' }, { key: 'global', label: '国际版', prefix: 'wbai' }] },
  { key: 'qoder', name: 'Qoder', sub: '阿里系 · 订阅额度', Icon: TerminalIcon, page: 'qoder', regions: [{ key: 'cn', label: '国内版', prefix: 'qoder' }, { key: 'global', label: '国际版', prefix: 'qoderg' }] },
];

/** 状态点三级判定：启动错误/failed → 红；停用/未登录/目录降级 → 黄；其余绿 */
function regionState(p) {
  if (!p) return { cls: 'mute', title: '未加载' };
  if (p.error || p.status === 'failed') return { cls: 'err', title: p.error ?? p.reason ?? '不可用' };
  if (p.enabled === false) return { cls: 'warn', title: '已停用' };
  if (p.status === 'signed-out' || p.degraded) return { cls: 'warn', title: p.reason ?? '未就绪' };
  return { cls: 'ok', title: '就绪' };
}

/** 总览：端点 + 每个产品的区服状态，点击直达对应页 */
export default function OverviewPage({ health, navigate }) {
  // 端点以后端宣告为准（网关自己知道真实端口）；旧后端没有该字段时回落当前 origin
  const endpoint = health?.endpoint ?? `${window.location.protocol}//${window.location.host}/v1`;
  const total = health?.providers.reduce((n, p) => n + p.models, 0);

  return (
    <div className="content-inner">
      <header className="page-head">
        <div>
          <h1 className="page-title">
            <span className="page-icon"><GaugeIcon size={22} /></span>
            总览
          </h1>
          <p className="page-sub">
            本地订阅中转网关 · 共 {total ?? '…'} 个模型 · 三家订阅全部转成 OpenAI 兼容接口
          </p>
        </div>
      </header>

      <section className="section">
        <div className="endpoint" title="OpenAI 兼容接口；API Key 填 AiHub 设置页里的网关 Bearer Token">
          <PlugMark />
          <span className="url">{endpoint}</span>
          <CopyButton className="btn sm" value={endpoint} title="复制端点">复制</CopyButton>
          <span className="meta">
            OpenAI 兼容 · Chat Completions · 模型名 <code className="inline">前缀/模型ID</code>
          </span>
        </div>
      </section>

      {!health && <div className="section"><div className="skeleton" style={{ height: 120 }} /></div>}

      {health && (
        <div className="relay-channel-grid">
          {PRODUCTS.map(({ key, name, sub, Icon, page, regions }) => (
            <div className="relay-channel-card" key={key}>
              <div className="relay-channel-card-head">
                <span className="cc-icon"><Icon size={18} /></span>
                <div>
                  <div className="cc-name">{name}</div>
                  <div className="cc-sub">{sub}</div>
                </div>
              </div>
              {regions.map((r) => {
                const p = health.providers.find((x) => x.prefix === r.prefix);
                const s = regionState(p);
                return (
                  <button key={r.key} type="button" className="region-row" onClick={() => navigate(page, { r: r.key })}>
                    <span className={`nav-dot ${s.cls}`} title={s.title} />
                    <span>{r.label}</span>
                    <span className="prefix">{r.prefix}/</span>
                    <span className="grow" />
                    <span className="models">{p ? `${p.models} 模型` : '—'}</span>
                    <span className="chev"><ChevronRightIcon size={15} /></span>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function PlugMark() {
  return <GlobeIcon size={17} style={{ color: 'var(--accent)' }} />;
}
