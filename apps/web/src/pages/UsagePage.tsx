import { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { App as AntApp, Button, DatePicker, Select, Table, Tag, Typography } from 'antd';
import type { UsageEntryDto, UsageReportDto, UsageSummaryDto } from '@aihub/shared';

import { getData } from '../api.js';

const CHANNELS = [
  { value: 'relay:trae', label: 'Trae 国内版' },
  { value: 'relay:traeg', label: 'Trae 国际版' },
  { value: 'relay:wb', label: 'WorkBuddy 国内版' },
  { value: 'relay:wbai', label: 'WorkBuddy 国际版' },
  { value: 'relay:qoder', label: 'Qoder 国内版' },
  { value: 'relay:qoderg', label: 'Qoder 国际版' },
];

const STATUS_COLORS: Record<string, string> = {
  ok: 'success',
  error: 'error',
  aborted: 'default',
  upstream_error: 'warning',
};

function formatToken(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return value.toLocaleString('zh-CN');
}

function formatCredits(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return value.toLocaleString('zh-CN', { maximumFractionDigits: 4 });
}

function downloadCsv(entries: UsageEntryDto[]): void {
  const header = ['时间', '通道', '模型名', '调用 ID', '输入 token', '输出 token', '合计', '缓存 token', '倍率', '积分消耗', '状态'];
  const lines = entries.map((entry) => [
    new Date(entry.createdAt * 1000).toISOString(),
    entry.channelName ?? '',
    entry.modelName ?? '',
    entry.virtualModel,
    entry.promptTokens ?? '',
    entry.completionTokens ?? '',
    entry.totalTokens ?? '',
    entry.cachedTokens ?? '',
    entry.creditRate ?? '',
    entry.credits ?? '',
    entry.status,
  ].map((value) => `"${String(value).replaceAll('"', '""')}"`).join(','));
  const blob = new Blob([`\uFEFF${[header.join(','), ...lines].join('\n')}`], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'aihub-usage.csv';
  link.click();
  URL.revokeObjectURL(url);
}

export function UsagePage({ token }: { token: string }) {
  const { message } = AntApp.useApp();
  const [report, setReport] = useState<UsageReportDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [filters, setFilters] = useState<{ channelId?: string; from?: number; to?: number }>({});

  function setRange(days: number) {
    const end = Math.floor(Date.now() / 1000);
    const start = days === 0
      ? Math.floor(new Date().setHours(0, 0, 0, 0) / 1000)
      : end - days * 86_400;
    setFilters((current) => ({ ...current, from: start, to: end }));
  }

  async function load() {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (filters.channelId) params.set('channelId', filters.channelId);
      if (filters.from !== undefined) params.set('from', String(filters.from));
      if (filters.to !== undefined) params.set('to', String(filters.to));
      const query = params.size > 0 ? `?${params}` : '';
      setReport(await getData<UsageReportDto>(`/api/admin/usage${query}`, token));
    } catch (error) {
      message.error(error instanceof Error ? error.message : '加载用量失败');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, [filters]);

  const summary = report?.summary ?? [];
  const entries = report?.entries ?? [];

  return (
    <div className="page-stack">
      <div className="page-heading">
        <div>
          <Typography.Title level={2}>用量</Typography.Title>
          <Typography.Text type="secondary">
            只统计经过本网关的订阅请求。积分 =（输入 + 输出）token × 倍率 / 1000。开始记账之前的请求没有 token，积分也算不出来。
          </Typography.Text>
        </div>
        <Button icon={<RefreshCw size={16} />} onClick={() => void load()} loading={loading}>
          刷新
        </Button>
        <Button onClick={() => downloadCsv(entries)}>导出 CSV</Button>
      </div>

      <div className="filter-panel">
        <div className="filter-chips">
          <button type="button" className="chip" onClick={() => setRange(0)}>今天</button>
          <button type="button" className="chip" onClick={() => setRange(7)}>近 7 天</button>
          <button type="button" className="chip" onClick={() => setRange(30)}>近 30 天</button>
        </div>
        <div className="filter-panel-grid">
          <div className="filter-field">
            <span className="meta-label">通道</span>
            <Select
              allowClear
              placeholder="全部订阅通道"
              style={{ width: '100%' }}
              value={filters.channelId}
              onChange={(value) => setFilters((current) => ({ ...current, channelId: value }))}
              options={CHANNELS}
            />
          </div>
          <div className="filter-field">
            <span className="meta-label">时间范围</span>
            <DatePicker.RangePicker
              showTime
              style={{ width: '100%' }}
              onChange={(range) => {
                setFilters((current) => ({
                  ...current,
                  from: range?.[0] ? Math.floor(range[0].valueOf() / 1000) : undefined,
                  to: range?.[1] ? Math.floor(range[1].valueOf() / 1000) : undefined,
                }));
              }}
            />
          </div>
        </div>
      </div>

      <Typography.Title level={4}>按模型汇总</Typography.Title>
      <Table<UsageSummaryDto>
        rowKey={(row) => `${row.channelId ?? ''}:${row.model}`}
        loading={loading}
        dataSource={summary}
        pagination={false}
        locale={{ emptyText: '还没有订阅请求' }}
        columns={[
          { title: '通道', dataIndex: 'channelName', width: 160, render: (value: string | null) => value || '—' },
          { title: '模型名', dataIndex: 'modelName', width: 180, render: (value: string | null) => value || '—' },
          { title: '调用 ID', dataIndex: 'model' },
          { title: '请求数', dataIndex: 'requests', align: 'right', width: 100 },
          {
            title: '输入 token',
            dataIndex: 'promptTokens',
            align: 'right',
            width: 120,
            render: (value: number | null) => formatToken(value),
          },
          {
            title: '输出 token',
            dataIndex: 'completionTokens',
            align: 'right',
            width: 120,
            render: (value: number | null) => formatToken(value),
          },
          {
            title: '积分消耗',
            dataIndex: 'credits',
            align: 'right',
            width: 120,
            render: (value: number | null) => formatCredits(value),
          },
        ]}
      />

      <Typography.Title level={4}>明细</Typography.Title>
      <Table<UsageEntryDto>
        rowKey="id"
        loading={loading}
        dataSource={entries}
        size="small"
        scroll={{ x: 1280 }}
        pagination={{ pageSize: 50, showSizeChanger: false }}
        locale={{ emptyText: '没有符合筛选的请求' }}
        columns={[
          {
            title: '时间',
            dataIndex: 'createdAt',
            width: 170,
            render: (value: number) => new Date(value * 1000).toLocaleString('zh-CN', { hour12: false }),
          },
          { title: '通道', dataIndex: 'channelName', width: 150, render: (value: string | null) => value || '—' },
          { title: '模型名', dataIndex: 'modelName', width: 160, render: (value: string | null) => value || '—' },
          { title: '调用 ID', dataIndex: 'virtualModel', width: 220 },
          {
            title: '输入 token',
            dataIndex: 'promptTokens',
            align: 'right',
            width: 110,
            render: (value: number | null) => formatToken(value),
          },
          {
            title: '输出 token',
            dataIndex: 'completionTokens',
            align: 'right',
            width: 110,
            render: (value: number | null) => formatToken(value),
          },
          {
            title: '合计',
            dataIndex: 'totalTokens',
            align: 'right',
            width: 100,
            render: (value: number | null) => formatToken(value),
          },
          {
            title: '缓存 token',
            dataIndex: 'cachedTokens',
            align: 'right',
            width: 110,
            render: (value: number | null) => formatToken(value),
          },
          { title: '倍率', dataIndex: 'creditRate', width: 90, render: (value: string | null) => value || '—' },
          {
            title: '积分消耗',
            dataIndex: 'credits',
            align: 'right',
            width: 110,
            render: (value: number | null) => formatCredits(value),
          },
          {
            title: '状态',
            dataIndex: 'status',
            width: 130,
            render: (value: string) => <Tag color={STATUS_COLORS[value] ?? 'default'}>{value}</Tag>,
          },
        ]}
      />
    </div>
  );
}
