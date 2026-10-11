import React from 'react';
import ReactDOM from 'react-dom/client';
import { App as AntApp, ConfigProvider, theme } from 'antd';
import zhCN from 'antd/locale/zh_CN';

import { App } from './App.js';
import './styles.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ConfigProvider
      locale={zhCN}
      theme={{
        algorithm: theme.darkAlgorithm,
        token: {
          colorPrimary: '#3dd6c6',
          colorInfo: '#3dd6c6',
          colorSuccess: '#62d18a',
          colorWarning: '#e6b35a',
          colorError: '#f06a6a',
          colorBgBase: '#0b0f12',
          colorBgContainer: '#141a1f',
          colorBgElevated: '#1a2228',
          colorBorder: '#2a353d',
          borderRadius: 6,
          fontFamily: '"IBM Plex Sans", "Noto Sans SC", "Microsoft YaHei", sans-serif',
        },
        components: {
          Layout: {
            siderBg: '#0e1317',
            headerBg: '#0e1317',
            bodyBg: '#0b0f12',
          },
          Card: {
            colorBgContainer: '#141a1f',
          },
          Table: {
            headerBg: '#182127',
            rowHoverBg: '#1c272e',
          },
        },
      }}
    >
      <AntApp>
        <App />
      </AntApp>
    </ConfigProvider>
  </React.StrictMode>,
);
