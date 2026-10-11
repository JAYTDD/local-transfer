import {
  Cable,
  ScrollText,
  Settings,
} from 'lucide-react';
import { Layout, Menu, Space, Typography } from 'antd';
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { BrowserRouter } from 'react-router-dom';

import { ChannelsPage } from './pages/ChannelsPage.js';
import { LogsPage } from './pages/LogsPage.js';
import { SettingsPage } from './pages/SettingsPage.js';

const { Header, Sider, Content } = Layout;

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
      <Sider width={228} className="app-sider">
        <div className="sider-brand">
          <div className="brand-mark small">AI</div>
          <div>
            <div className="sider-title">AiHub</div>
            <div className="sider-subtitle">LOCAL GATEWAY</div>
          </div>
        </div>
        <Menu
          mode="inline"
          selectedKeys={[selected]}
          onClick={({ key }) => navigate(`/${key}`)}
          items={[
            { key: 'channels', icon: <Cable size={16} />, label: '渠道' },
            { key: 'logs', icon: <ScrollText size={16} />, label: '日志' },
            { key: 'settings', icon: <Settings size={16} />, label: '设置' },
          ]}
        />
      </Sider>
      <Layout>
        <Header className="app-header">
          <Space>
            <span className="status-dot" />
            <Typography.Text type="secondary">网关运行中</Typography.Text>
          </Space>
          <Typography.Text type="secondary">仅本机管理</Typography.Text>
        </Header>
        <Content className="app-content">
          <Routes>
            <Route path="/" element={<Navigate to="/channels" replace />} />
            <Route path="/channels" element={<ChannelsPage token={token} />} />
            <Route path="/logs" element={<LogsPage token={token} />} />
            <Route path="/settings" element={<SettingsPage token={token} />} />
            <Route path="*" element={<Navigate to="/channels" replace />} />
          </Routes>
        </Content>
      </Layout>
    </Layout>
  );
}
