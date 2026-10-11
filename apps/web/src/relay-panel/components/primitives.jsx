import React, { useEffect, useRef, useState } from 'react';
import { AlertIcon, CheckIcon, CopyIcon } from './icons.jsx';

/** 通用工具：时间戳 → 本地时间；数字裁剪长尾 */
export function fmtTime(ts) {
  if (typeof ts !== 'number' || ts <= 0) return null;
  return new Date(ts).toLocaleString('zh-CN', { hour12: false });
}

export function fmtNum(v) {
  if (typeof v !== 'number') return null;
  return String(Math.round(v * 1e4) / 1e4);
}

/** 上下文窗口 → 紧凑可读：200K / 1M */
export function fmtCtx(w) {
  if (typeof w !== 'number' || w <= 0) return null;
  return w >= 1_000_000 ? `${Math.round(w / 100_000) / 10}M` : `${Math.round(w / 1000)}K`;
}

/** 倍率：后端 normalizeCredits 可能给 'x0.29'（已带 x）也可能给数字，统一成单 x 前缀 */
export function fmtRate(rate) {
  if (rate === undefined || rate === null) return null;
  if (typeof rate === 'number') return `x${rate}`;
  const s = String(rate).trim();
  return s.startsWith('x') ? s : `x${s}`;
}

/** 登录/配置状态胶囊 */
export function StatusPill({ ok, label, title }) {
  return (
    <span className={`pill ${ok ? 'ok' : 'warn'}`} title={title}>
      <span className="dot" />
      {label}
    </span>
  );
}

/** 指标块；hero = 主指标（强调色大数字） */
export function Metric({ label, value, unit, hero, hint }) {
  if (value === null || value === undefined) return null;
  return (
    <div className={`metric ${hero ? 'hero' : ''}`}>
      <div className="k">{label}</div>
      <div className="v">
        {value}
        {unit && <span className="unit">{unit}</span>}
      </div>
      {hint && <div className="k" style={{ marginTop: 2 }}>{hint}</div>}
    </div>
  );
}

/** 内容区块 */
export function Section({ title, count, hint, actions, children }) {
  return (
    <section className="section">
      {(title || actions) && (
        <div className="section-head">
          <h2 className="section-title">
            {title}
            {count !== undefined && <span className="count">{count}</span>}
          </h2>
          <div className="toolbar">{hint}</div>
          {actions && <div className="toolbar">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

/** 操作结果提示条 */
export function Notice({ kind = 'info', children }) {
  if (!children) return null;
  return (
    <div className={`notice ${kind}`}>
      {kind === 'ok' ? <CheckIcon size={15} /> : <AlertIcon size={15} />}
      <span>{children}</span>
    </div>
  );
}

/** 点击复制（用于模型 ID、端点） */
export function CopyButton({ value, className = '', children, title = '点击复制' }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef();
  useEffect(() => () => clearTimeout(timer.current), []);

  async function copy(e) {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      // 剪贴板不可用（非安全上下文等）时退回选中提示，不弹错打扰
      return;
    }
    setCopied(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1400);
  }

  return (
    <button
      type="button"
      className={`${className} ${copied ? 'copied' : ''}`}
      onClick={copy}
      title={copied ? '已复制' : title}
    >
      {children}
      {className.includes('model-id') && (
        <span className="copy-hint">{copied ? '已复制' : <CopyIcon size={12} />}</span>
      )}
    </button>
  );
}

/** 开关（设置项用）；checked 受控 */
export function Switch({ checked, onChange, disabled, label }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className={`switch ${checked ? 'on' : ''}`}
      onClick={() => onChange(!checked)}
    >
      <span className="knob" />
    </button>
  );
}

/** 空状态 */
export function EmptyState({ icon, title, sub, children }) {
  return (
    <div className="empty">
      <div className="empty-icon">{icon}</div>
      <div className="empty-title">{title}</div>
      {sub && <div className="empty-sub">{sub}</div>}
      {children}
    </div>
  );
}

/** 首屏加载骨架 */
export function LoadingBlock({ lines = 3, tall }) {
  return (
    <div style={{ display: 'grid', gap: 10 }}>
      {Array.from({ length: lines }, (_, i) => (
        <div key={i} className="skeleton" style={{ height: tall ? 44 : 16, width: `${100 - i * 12}%` }} />
      ))}
    </div>
  );
}

/** 可折叠的诊断详情（技术细节默认收起） */
export function Disclosure({ summary, children, open }) {
  return (
    <details className="disclosure" open={open}>
      <summary>
        <span className="chev">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M9 18l6-6-6-6" /></svg>
        </span>
        {summary}
      </summary>
      <div className="disclosure-body">{children}</div>
    </details>
  );
}
