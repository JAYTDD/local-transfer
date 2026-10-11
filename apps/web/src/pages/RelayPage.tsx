import { useCallback, useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { Alert, App as AntApp, Button, Card, Space, Switch, Tabs, Tag, Typography } from 'antd';
import type { RelayChannelToggle, RelayStatusDto } from '@aihub/shared';

import { getData, mutateData } from '../api.js';
import { api as relayApi } from '../relay-panel/api.js';
import OverviewPage from '../relay-panel/pages/OverviewPage.jsx';
import QoderPage from '../relay-panel/pages/QoderPage.jsx';
import TraePage from '../relay-panel/pages/TraePage.jsx';
import WorkBuddyPage from '../relay-panel/pages/WorkBuddyPage.jsx';
import '../relay-panel/panel.css';

const CHANNEL_KEYS: Array<keyof RelayChannelToggle> = ['trae', 'workbuddy', 'qoder'];

const CHANNEL_LABELS: Record<keyof RelayChannelToggle, string> = {
  trae: 'Trae',
  workbuddy: 'WorkBuddy',
  qoder: 'Qoder',
};

const CHANNEL_HINTS: Record<keyof RelayChannelToggle, string> = {
  trae: '国内版与国际版两个区域',
  workbuddy: '国内版与国际版两个变体',
  qoder: '国内版与国际版两个变体',
};

interface RelayHealthProvider {
  prefix: string;
  label?: string;
  models: number;
  status?: string;
  error?: string;
  reason?: string;
  enabled?: boolean;
  degraded?: boolean;
}

interface RelayHealth {
  ok?: boolean;
  endpoint?: string;
  providers: RelayHealthProvider[];
}

type RelayPanelRoute = 'overview' | 'trae' | 'workbuddy' | 'qoder' | 'settings';

export function RelayPage({ token }: { token: string }) {
  const { message } = AntApp.useApp();
  const [status, setStatus] = useState<RelayStatusDto | null>(null);
  const [health, setHealth] = useState<RelayHealth | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [activeTab, setActiveTab] = useState<RelayPanelRoute>('overview');
  const [traeRegion, setTraeRegion] = useState<'cn' | 'ai'>('cn');
  const [variant, setVariant] = useState<'cn' | 'global'>('cn');

  const loadHealth = useCallback(async () => {
    try {
      setHealth((await relayApi.getHealth()) as RelayHealth);
    } catch {
      setHealth(null);
    }
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setStatus(await getData<RelayStatusDto>('/api/admin/relay', token));
      await loadHealth();
    } catch (error) {
      message.error(error instanceof Error ? error.message : '加载订阅中转状态失败');
    } finally {
      setLoading(false);
    }
  }, [loadHealth, message, token]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const timer = setInterval(() => void loadHealth(), 30_000);
    return () => clearInterval(timer);
  }, [loadHealth]);

  const enabled = status?.enabled ?? false;

  // 模块关闭时自动落到「设置」，避免一进来就是空的面板页
  useEffect(() => {
    if (!loading && !enabled) setActiveTab('settings');
  }, [enabled, loading]);

  /**
   * 开关落盘后会同步触发模块的装配/释放（读凭据、起 shim、拉目录），
   * 所以这个请求可能要几秒才回——loading 要一直挂着，别让用户以为没生效。
   */
  async function update(patch: { enabled?: boolean; channels?: Partial<RelayChannelToggle> }) {
    setSaving(true);
    try {
      setStatus(await mutateData<RelayStatusDto>('/api/admin/relay', token, 'PUT', patch));
      await loadHealth();
      message.success('已保存');
    } catch (error) {
      message.error(error instanceof Error ? error.message : '保存失败');
      await load();
    } finally {
      setSaving(false);
    }
  }

  function openPanelPage(page: string, query?: { r?: string }) {
    setActiveTab(page as RelayPanelRoute);
    if (page === 'trae') setTraeRegion(query?.r === 'ai' ? 'ai' : 'cn');
    if (page === 'workbuddy' || page === 'qoder') setVariant(query?.r === 'global' ? 'global' : 'cn');
  }

  const disabledNotice = (
    <Alert
      type="info"
      showIcon
      message="订阅中转模块已关闭"
      description="在「设置」里打开总开关后，这里会显示通道数据与运行状态。"
    />
  );

  const settingsPanel = (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card title="总开关" className="settings-card" loading={loading}>
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Space size={12}>
            <Switch
              checked={enabled}
              loading={saving}
              onChange={(checked) => void update({ enabled: checked })}
            />
            <Typography.Text>{enabled ? '已启用' : '已禁用'}</Typography.Text>
          </Space>
          <Typography.Text type="secondary">
            启用后模型以 <span className="mono">前缀/模型ID</span> 的形式出现在 /v1/models 里，
            例如 <span className="mono">trae/xxx</span>、<span className="mono">qoder/xxx</span>。
            这些名字由模块优先接管，不走渠道配置。
          </Typography.Text>
          <Typography.Text type="secondary">
            凭据直接复用本机已登录的客户端，不需要在这里填密钥；状态文件在{' '}
            <span className="mono">~/.dsh/local-relay/</span>，与渠道、日志完全独立。
          </Typography.Text>
        </Space>
      </Card>

      <Card title="通道" className="settings-card" loading={loading}>
        <Space direction="vertical" size={16} style={{ width: '100%' }}>
          {CHANNEL_KEYS.map((key) => (
            <div className="settings-row" key={key}>
              <span className="meta-label">{CHANNEL_LABELS[key]}</span>
              <Space size={12}>
                <Switch
                  checked={status?.channels[key] ?? false}
                  disabled={!enabled || saving}
                  onChange={(checked) => void update({ channels: { [key]: checked } })}
                />
                <Typography.Text type="secondary">{CHANNEL_HINTS[key]}</Typography.Text>
              </Space>
            </div>
          ))}
          <Typography.Text type="secondary">
            单个通道关闭时，它的两个变体一起下线（模型不出现、请求按未配置模型处理）。
          </Typography.Text>
        </Space>
      </Card>

      {enabled && status?.prefixes.some((prefix) => prefix.error) ? (
        <Space wrap>
          {status.prefixes
            .filter((prefix) => prefix.error)
            .map((prefix) => (
              <Tag color="error" key={prefix.prefix}>
                {prefix.prefix}/ 不可用：{prefix.error}
              </Tag>
            ))}
        </Space>
      ) : null}
    </Space>
  );

  const panelItems = [
    {
      key: 'overview',
      label: '总览',
      children: enabled ? <OverviewPage health={health} navigate={openPanelPage} /> : disabledNotice,
    },
    {
      key: 'trae',
      label: 'Trae',
      children: enabled ? (
        <TraePage
          key={traeRegion}
          region={traeRegion}
          onRegion={(region: 'cn' | 'ai') => setTraeRegion(region)}
          onChannelChanged={loadHealth}
        />
      ) : (
        disabledNotice
      ),
    },
    {
      key: 'workbuddy',
      label: 'WorkBuddy',
      children: enabled ? (
        <WorkBuddyPage
          key={variant}
          variant={variant}
          onVariant={(next: 'cn' | 'global') => setVariant(next)}
          onChannelChanged={loadHealth}
        />
      ) : (
        disabledNotice
      ),
    },
    {
      key: 'qoder',
      label: 'Qoder',
      children: enabled ? (
        <QoderPage
          key={variant}
          variant={variant}
          onVariant={(next: 'cn' | 'global') => setVariant(next)}
          onChannelChanged={loadHealth}
        />
      ) : (
        disabledNotice
      ),
    },
    {
      key: 'settings',
      label: '设置',
      children: settingsPanel,
    },
  ];

  return (
    <div className="page-stack">
      <div className="page-heading">
        <div>
          <Typography.Title level={2}>订阅中转</Typography.Title>
          <Typography.Text type="secondary">
            把 Trae / WorkBuddy / Qoder 的订阅额度接成本地模型通道，模型名带前缀并入 /v1
          </Typography.Text>
        </div>
        <Space>
          <Button icon={<RefreshCw size={16} />} onClick={() => void load()} loading={loading}>
            刷新
          </Button>
        </Space>
      </div>

      <div className="relay-panel">
        <Tabs
          activeKey={activeTab}
          onChange={(key) => setActiveTab(key as RelayPanelRoute)}
          items={panelItems}
        />
      </div>
    </div>
  );
}
