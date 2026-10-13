import { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { Alert, App as AntApp, Button, Table, Typography } from 'antd';
import type { ModelCapabilitiesDto, ModelCapabilityDto } from '@aihub/shared';

import { getData } from '../api.js';

function formatTokens(value: number | undefined): string {
  if (value === undefined) return '—';
  if (value >= 1_000_000) {
    const scaled = value / 1_000_000;
    return `${Number.isInteger(scaled) ? scaled : scaled.toFixed(1)}M`;
  }
  if (value >= 1000) {
    const scaled = value / 1000;
    return `${Number.isInteger(scaled) ? scaled : scaled.toFixed(1)}K`;
  }
  return String(value);
}

function formatReasoning(reasoning: ModelCapabilityDto['reasoning']): string {
  if (!reasoning?.supported) return '—';
  const efforts = reasoning.efforts ?? [];
  if (efforts.length === 0) return '支持';
  return efforts
    .map((effort) => (effort === reasoning.defaultEffort ? `${effort}（默认）` : effort))
    .join('、');
}

function formatFetchedAt(fetchedAt: number | null): string {
  if (fetchedAt === null) return '订阅中转未装配，不会请求上游。';
  const time = new Date(fetchedAt).toLocaleString('zh-CN', { hour12: false });
  return `目录更新于 ${time}。5 分钟内再次打开不会重新请求上游。`;
}

export function ModelsPage({ token }: { token: string }) {
  const { message } = AntApp.useApp();
  const [data, setData] = useState<ModelCapabilitiesDto | null>(null);
  const [loading, setLoading] = useState(true);

  async function load(force = false) {
    setLoading(true);
    try {
      const path = force ? '/api/admin/model-capabilities?refresh=1' : '/api/admin/model-capabilities';
      setData(await getData<ModelCapabilitiesDto>(path, token));
    } catch (error) {
      message.error(error instanceof Error ? error.message : '加载模型能力失败');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  const snapshot = data ?? { models: [], fetchedAt: null, errors: [] };

  return (
    <div className="page-stack">
      <div className="page-heading">
        <div>
          <Typography.Title level={2}>模型</Typography.Title>
          <Typography.Text type="secondary">
            只显示订阅中转里已启用、可以调用的模型。{formatFetchedAt(snapshot.fetchedAt)}
          </Typography.Text>
        </div>
        <Button icon={<RefreshCw size={16} />} onClick={() => void load(true)} loading={loading}>
          重新拉取
        </Button>
      </div>

      {snapshot.errors.length > 0 && (
        <Alert
          type="warning"
          showIcon
          message="部分通道的目录刷新失败，列表仍显示该通道内存中的模型"
          description={snapshot.errors.map((error) => `${error.label || error.prefix || '通道'}：${error.message}`).join('；')}
        />
      )}

      <Table<ModelCapabilityDto>
        rowKey="id"
        loading={loading}
        dataSource={snapshot.models}
        pagination={false}
        locale={{ emptyText: snapshot.fetchedAt === null ? '订阅中转未装配' : '没有已启用的模型' }}
        columns={[
          { title: '通道', dataIndex: 'channel', width: 180 },
          {
            title: '调用 ID',
            dataIndex: 'id',
            render: (id: string) => <Typography.Text copyable code>{id}</Typography.Text>,
          },
          { title: '名称', dataIndex: 'name' },
          {
            title: '上下文',
            dataIndex: 'contextWindow',
            align: 'right',
            width: 120,
            render: (value: number | undefined) => formatTokens(value),
          },
          {
            title: '最大输出 token',
            dataIndex: 'maxTokens',
            align: 'right',
            width: 140,
            render: (value: number | undefined) => formatTokens(value),
          },
          {
            title: '思考等级',
            dataIndex: 'reasoning',
            width: 280,
            render: (value: ModelCapabilityDto['reasoning']) => formatReasoning(value),
          },
          {
            title: '倍率',
            dataIndex: 'creditRate',
            width: 90,
            render: (value: string | undefined) => value || '—',
          },
          {
            title: '默认思考',
            dataIndex: 'defaultReasoningEffort',
            width: 110,
            render: (value: string | undefined) => value || '—',
          },
          {
            title: '图片输入',
            dataIndex: 'supportsImages',
            width: 100,
            render: (value: boolean | undefined) => (value ? '支持' : '—'),
          },
        ]}
      />
    </div>
  );
}
