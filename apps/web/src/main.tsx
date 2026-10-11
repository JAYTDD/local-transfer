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
          colorPrimary: '#2ed3c1',
          colorInfo: '#7fb3ff',
          colorSuccess: '#45d483',
          colorWarning: '#f0b354',
          colorError: '#f0707c',
          colorBgBase: '#090d13',
          colorBgContainer: '#10161f',
          colorBgElevated: '#151d28',
          colorBorder: '#2b394b',
          colorText: '#e9eff7',
          colorTextSecondary: '#9db0c6',
          colorTextTertiary: '#6a7c92',
          borderRadius: 8,
          fontFamily: '"IBM Plex Sans", "Noto Sans SC", "Microsoft YaHei", sans-serif',
          motionDurationFast: '0.14s',
          motionDurationMid: '0.24s',
          motionDurationSlow: '0.38s',
          motionEaseOut: 'cubic-bezier(0.22, 1, 0.36, 1)',
        },
        components: {
          Layout: {
            siderBg: '#0c1118',
            headerBg: '#090d13',
            bodyBg: '#090d13',
          },
          Card: {
            colorBgContainer: '#10161f',
          },
          Table: {
            headerBg: '#151d28',
            rowHoverBg: '#1b2432',
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
