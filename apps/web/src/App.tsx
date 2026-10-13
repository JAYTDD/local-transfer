import {
  BarChart3,
  Boxes,
  Cable,
  Cpu,
  ScrollText,
  Settings,
} from 'lucide-react';
import { Layout, Menu } from 'antd';
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { BrowserRouter } from 'react-router-dom';

import { ChannelsPage } from './pages/ChannelsPage.js';
import { LogsPage } from './pages/LogsPage.js';
import { ModelsPage } from './pages/ModelsPage.js';
import { RelayPage } from './pages/RelayPage.js';
import { SettingsPage } from './pages/SettingsPage.js';
import { UsagePage } from './pages/UsagePage.js';

const { Content } = Layout;

export function App() {
  return (
    <BrowserRouter basename="/admin">
      <AdminShell />
    </BrowserRouter>
  );
}

function AdminShell() {
  const navigate = useNavigate();
  const location = useLocation();
  const token = '';
  const selected = location.pathname.split('/')[1] || 'channels';
  return (
    <Layout className="app-shell">
      <header className="app-header">
        <div className="app-topbar">
          <div className="topbar-brand">
            <div className="brand-mark small">AI</div>
            <div className="topbar-brand-text">
              <span className="topbar-title">AiHub</span>
              <span className="topbar-sub">本地 AI 中转网关</span>
            </div>
          </div>
          <div className="topbar-status">
            <span className="status-dot" />
            <span>网关运行中</span>
            <span className="topbar-divider" />
            <span className="topbar-dim">仅本机管理</span>
          </div>
        </div>
        <nav className="app-navbar" aria-label="主导航">
          <Menu
            mode="horizontal"
            selectedKeys={[selected]}
            onClick={({ key }) => navigate(`/${key}`)}
            items={[
              { key: 'channels', icon: <Cable size={15} />, label: '渠道' },
              { key: 'relay', icon: <Boxes size={15} />, label: '订阅中转' },
              { key: 'models', icon: <Cpu size={15} />, label: '模型' },
              { key: 'usage', icon: <BarChart3 size={15} />, label: '用量' },
              { key: 'logs', icon: <ScrollText size={15} />, label: '日志' },
              { key: 'settings', icon: <Settings size={15} />, label: '设置' },
            ]}
          />
        </nav>
      </header>
      <Content className="app-content">
        <Routes>
          <Route path="/" element={<Navigate to="/channels" replace />} />
          <Route path="/channels" element={<ChannelsPage token={token} />} />
          <Route path="/relay" element={<RelayPage token={token} />} />
          <Route path="/models" element={<ModelsPage token={token} />} />
          <Route path="/usage" element={<UsagePage token={token} />} />
          <Route path="/logs" element={<LogsPage token={token} />} />
          <Route path="/settings" element={<SettingsPage token={token} />} />
          <Route path="*" element={<Navigate to="/channels" replace />} />
        </Routes>
      </Content>
    </Layout>
  );
}
