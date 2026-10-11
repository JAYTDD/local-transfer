import React, { useMemo, useState } from 'react';
import { CopyButton, EmptyState } from './primitives.jsx';
import { InboxIcon, SearchIcon } from './icons.jsx';

/**
 * 模型列表：搜索过滤 + 点击 ID 复制。
 * columns: [{ key, label, numeric?, render(m) }] 由各通道页决定额外列。
 * rowClass(m) 返回额外的行类名（如停用/隐藏行变灰）。
 */
export default function ModelTable({ models, columns = [], emptyText = '未发现模型', rowClass }) {
  const [kw, setKw] = useState('');
  const keyword = kw.trim().toLowerCase();

  const rows = useMemo(() => {
    if (!models) return null;
    if (!keyword) return models;
    return models.filter(
      (m) => m.id.toLowerCase().includes(keyword) || (m.name ?? '').toLowerCase().includes(keyword),
    );
  }, [models, keyword]);

  if (!models) return null;

  return (
    <div style={{ display: 'grid', gap: 10 }}>
      {models.length > 6 && (
        <div className="toolbar" style={{ justifyContent: 'space-between' }}>
          <div className="search">
            <SearchIcon size={14} />
            <input
              value={kw}
              onChange={(e) => setKw(e.target.value)}
              placeholder="搜索模型 ID 或名称…"
              spellCheck={false}
            />
          </div>
          <span className="section-hint">
            {keyword ? `匹配 ${rows.length} / ${models.length}` : `共 ${models.length} 个`}
          </span>
        </div>
      )}

      {rows.length === 0 ? (
        <EmptyState icon={<InboxIcon size={20} />} title={keyword ? '没有匹配的模型' : emptyText} />
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>模型 ID（点击复制）</th>
                <th>名称</th>
                {columns.map((c) => (
                  <th key={c.key} className={c.numeric ? 'num' : ''}>{c.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((m) => (
                <tr key={m.id} className={rowClass?.(m) || undefined}>
                  <td>
                    <CopyButton className="model-id" value={m.id}>
                      {m.id}
                    </CopyButton>
                  </td>
                  <td className="model-name">{m.name ?? m.id}</td>
                  {columns.map((c) => (
                    <td key={c.key} className={c.numeric ? 'num' : ''}>{c.render(m)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
