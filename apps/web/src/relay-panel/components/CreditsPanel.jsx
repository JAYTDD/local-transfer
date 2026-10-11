import React from 'react';
import { Disclosure, Metric, fmtNum } from './primitives.jsx';

/**
 * 额度展示：主指标 + 可选明细。
 * metrics: [{label, value, unit?, hero?, hint?}]（value 为 null 的项自动省略）
 * packs:   [{name, remain, size}] 有余额的额度/权益包，收进折叠明细
 */
export default function CreditsPanel({ metrics = [], packs = [], error, unavailable }) {
  const visible = metrics.filter((m) => m.value !== null && m.value !== undefined);
  const hasBody = visible.length > 0 || packs.length > 0 || unavailable;

  if (error) return <p className="small dim">额度读取失败：{error}</p>;
  if (!hasBody) return <p className="small dim">登录后显示额度</p>;

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      {visible.length > 0 && (
        <div className="metrics">
          {visible.map((m) => <Metric key={m.label} {...m} />)}
        </div>
      )}
      {unavailable && <p className="small dim">{unavailable}</p>}
      {packs.length > 0 && (
        <Disclosure summary={`额度包明细（有余额 ${packs.length} 个）`}>
          <ul className="mono-list">
            {packs.map((p, i) => (
              <li key={i}>
                {p.name || '（未命名）'}
                <span className="reason"> — 剩余 {fmtNum(p.remain)} / {fmtNum(p.size)}</span>
              </li>
            ))}
          </ul>
        </Disclosure>
      )}
    </div>
  );
}
