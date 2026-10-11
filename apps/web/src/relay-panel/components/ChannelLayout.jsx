import React from 'react';

/**
 * 通道页骨架：页头（图标 + 标题 + 区服分段切换 + 状态与操作）。
 * 区服选择同步到 hash query（#/trae?r=cn），刷新/分享链接都能落在同一视图。
 */
export default function ChannelLayout({ icon, title, sub, regions, region, onRegion, statusNode, actions, children }) {
  return (
    <div className="content-inner">
      <header className="page-head">
        <div>
          <h1 className="page-title">
            <span className="page-icon">{icon}</span>
            {title}
          </h1>
          {sub && <p className="page-sub">{sub}</p>}
        </div>
        <div className="page-actions">
          {statusNode}
          {regions && regions.length > 1 && (
            <div className="seg" role="tablist" aria-label="区服">
              {regions.map((r) => (
                <button
                  key={r.key}
                  type="button"
                  role="tab"
                  aria-selected={r.key === region}
                  className={r.key === region ? 'active' : ''}
                  onClick={() => onRegion(r.key)}
                >
                  {r.label}
                </button>
              ))}
            </div>
          )}
          {actions}
        </div>
      </header>
      {children}
    </div>
  );
}
