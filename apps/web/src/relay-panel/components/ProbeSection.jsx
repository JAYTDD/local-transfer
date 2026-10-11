import React from 'react';
import { Disclosure, fmtTime } from './primitives.jsx';
import { SparklesIcon } from './icons.jsx';

/**
 * 推理探针区（WorkBuddy / Qoder 共用）。
 * 会真发上游请求并消耗额度——默认整块收起，明确标注代价。
 */
export default function ProbeSection({ probe, busy, onProbe, idleLabel = '空闲', extraAction }) {
  if (!probe) return null;
  const candidates = probe.candidates ?? [];
  const results = probe.results ?? [];
  const done = new Set(results.map((r) => r.id));
  if (candidates.length === 0 && results.length === 0) return null;

  return (
    <Disclosure
      summary={
        <>
          <SparklesIcon size={14} /> 推理能力探测
          {results.length > 0 && `（已有 ${results.length} 项结果）`}
          {probe.running ? ' · 正在探测…' : candidates.length > 0 ? ` · ${candidates.length} 个候选` : ` · ${idleLabel}`}
          <span style={{ flex: 1 }} />
          {extraAction}
        </>
      }
    >
      {candidates.length > 0 && (
        <>
          <p className="small dim" style={{ margin: '2px 0 8px' }}>
            探测会向上游发起真实请求并消耗额度，点击模型逐个触发。
          </p>
          <div className="chip-row">
            {candidates.map((id) => (
              <button
                key={id}
                type="button"
                className="btn sm"
                disabled={busy !== '' || probe.running}
                onClick={() => onProbe(id)}
                title={done.has(id) ? '已有结果，可重测' : '尚未探测'}
              >
                {id}{done.has(id) ? ' ✓' : ''}
              </button>
            ))}
          </div>
        </>
      )}
      {results.length > 0 && (
        <ul className="mono-list" style={{ marginTop: 10 }}>
          {results.map((r) => (
            <li key={r.id}>
              {r.id}
              <span className="reason">
                {' — '}{r.validation}
                {r.efforts?.length ? `（${r.efforts.join('、')}）` : ''}
                {r.probedAt ? ` · ${fmtTime(r.probedAt)}` : ''}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Disclosure>
  );
}
