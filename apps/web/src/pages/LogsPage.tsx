import { useEffect, useState } from 'react';
import { Eye, RefreshCw } from 'lucide-react';
import {
  App as AntApp,
  Button,
  DatePicker,
  Descriptions,
  Drawer,
  Select,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import type { ChannelDto, RelayStatusDto, RequestLogDto } from '@aihub/shared';

import { getData } from '../api.js';

const STATUS_COLORS: Record<string, string> = {
  ok: 'success',
  error: 'error',
  aborted: 'default',
  upstream_error: 'warning',
};

export function LogsPage({ token }: { token: string }) {
  const { message } = AntApp.useApp();
  const [logs, setLogs] = useState<RequestLogDto[]>([]);
  const [channels, setChannels] = useState<ChannelDto[]>([]);
  const [relayPrefixes, setRelayPrefixes] = useState<RelayStatusDto['prefixes']>([]);
  const [loading, setLoading] = useState(true);
  const [detail, setDetail] = useState<RequestLogDto | null>(null);
  const [filters, setFilters] = useState<{
    model?: string;
    channelId?: string;
    status?: string;
    stream?: string;
  }>({});

  async function load() {
    setLoading(true);
    try {
      const params = new URLSearchParams({ limit: '500', offset: '0' });
      for (const [key, value] of Object.entries(filters)) {
        if (value) params.set(key, value);
      }
      const [nextLogs, nextChannels, relayStatus] = await Promise.all([
        getData<RequestLogDto[]>(`/api/admin/logs?${params}`, token),
        getData<ChannelDto[]>('/api/admin/channels', token),
        getData<RelayStatusDto>('/api/admin/relay', token),
      ]);
      setLogs(nextLogs);
      setChannels(nextChannels);
      setRelayPrefixes(relayStatus.prefixes);
    } catch (error) {
      message.error(error instanceof Error ? error.message : '加载日志失败');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, [filters]);

  return (
    <div className="page-stack">
      <div className="page-heading">
        <div>
          <Typography.Title level={2}>日志</Typography.Title>
          <Typography.Text type="secondary">默认展示最近 500 条请求记录</Typography.Text>
        </div>
        <Button icon={<RefreshCw size={16} />} onClick={() => void load()} loading={loading}>
          刷新
        </Button>
      </div>

      <div className="filter-panel">
        <div className="filter-chips">
          <button
            type="button"
            className={`chip ${!filters.status ? 'active' : ''}`}
            onClick={() => setFilters((current) => ({ ...current, status: undefined }))}
          >
            全部状态
          </button>
          {Object.keys(STATUS_COLORS).map((status) => (
            <button
              key={status}
              type="button"
              className={`chip ${filters.status === status ? 'active' : ''}`}
              onClick={() => setFilters((current) => ({ ...current, status }))}
            >
              {status}
            </button>
          ))}
        </div>
        <div className="filter-panel-grid">
          <div className="filter-field">
            <span className="meta-label">渠道</span>
            <Select
              allowClear
              placeholder="全部渠道"
              style={{ width: '100%' }}
              value={filters.channelId}
              onChange={(value) => setFilters((current) => ({ ...current, channelId: value }))}
              options={[
                ...channels.map((channel) => ({ value: channel.id, label: channel.name })),
                ...relayPrefixes.map((prefix) => ({ value: `relay:${prefix.prefix}`, label: prefix.label })),
              ]}
            />
          </div>
          <div className="filter-field">
            <span className="meta-label">请求类型</span>
            <Select
              allowClear
              placeholder="全部类型"
              style={{ width: '100%' }}
              value={filters.stream}
              onChange={(value) => setFilters((current) => ({ ...current, stream: value }))}
              options={[
                { value: 'true', label: '流式' },
                { value: 'false', label: '非流式' },
              ]}
            />
          </div>
          <div className="filter-field">
            <span className="meta-label">时间范围</span>
            <DatePicker.RangePicker
              showTime
              style={{ width: '100%' }}
              onChange={(range) => {
                const next = filters as typeof filters & { from?: string; to?: string };
                next.from = range?.[0] ? String(Math.floor(range[0].valueOf() / 1000)) : undefined;
                next.to = range?.[1] ? String(Math.floor(range[1].valueOf() / 1000)) : undefined;
                setFilters({ ...next });
              }}
            />
          </div>
        </div>
        <div className="filter-panel-actions">
          <Button onClick={() => setFilters({})}>重置筛选</Button>
        </div>
      </div>

      <Table
        rowKey="id"
        loading={loading}
        dataSource={logs}
        size="small"
        scroll={{ x: 1200 }}
        pagination={{ pageSize: 50, showSizeChanger: false }}
        onRow={(record) => ({ onClick: () => setDetail(record), style: { cursor: 'pointer' } })}
        columns={[
          {
            title: '时间',
            dataIndex: 'createdAt',
            width: 170,
            render: (value: number) => new Date(value * 1000).toLocaleString(),
          },
          { title: '模型', dataIndex: 'virtualModel', className: 'mono', width: 180 },
          { title: '渠道', dataIndex: 'channelName', width: 140, render: (value: string | null) => value || '-' },
          { title: '协议', dataIndex: 'protocol', width: 110, render: (value: string | null) => value || '-' },
          {
            title: '状态',
            dataIndex: 'status',
            width: 130,
            render: (value: string, record) => (
              <Space size={4}>
                <Tag color={STATUS_COLORS[value] ?? 'default'}>{value}</Tag>
                {record.httpStatus ? <span className="muted">{record.httpStatus}</span> : null}
              </Space>
            ),
          },
          { title: '类型', dataIndex: 'stream', width: 90, render: (value: boolean) => (value ? '流式' : '非流式') },
          { title: '耗时', dataIndex: 'durationMs', width: 100, render: (value: number) => `${value} ms` },
          {
            title: '错误摘要',
            dataIndex: 'errorSummary',
            ellipsis: true,
            render: (value: string | null) => value || '-',
          },
          {
            title: '操作',
            width: 80,
            render: (_value, record) => (
              <Tooltip title="详情">
                <Button
                  type="text"
                  aria-label={`查看日志 ${record.id}`}
                  icon={<Eye size={16} />}
                  onClick={(event) => {
                    event.stopPropagation();
                    setDetail(record);
                  }}
                />
              </Tooltip>
            ),
          },
        ]}
      />

      <Drawer title="请求详情" width={560} open={detail !== null} onClose={() => setDetail(null)}>
        {detail && (
          <Space direction="vertical" size={20} style={{ width: '100%' }}>
            <Descriptions
              column={1}
              size="small"
              bordered
              items={[
                {
                  key: 'createdAt',
                  label: '时间',
                  children: new Date(detail.createdAt * 1000).toLocaleString(),
                },
                {
                  key: 'virtualModel',
                  label: '模型',
                  children: <span className="mono">{detail.virtualModel}</span>,
                },
                {
                  key: 'channel',
                  label: '渠道',
                  children: detail.channelName
                    ? `${detail.channelName} (${detail.channelId})`
                    : '-',
                },
                { key: 'protocol', label: '协议', children: detail.protocol ?? '-' },
                {
                  key: 'status',
                  label: '状态',
                  children: (
                    <Space size={4}>
                      <Tag color={STATUS_COLORS[detail.status] ?? 'default'}>{detail.status}</Tag>
                      {detail.httpStatus ? <span className="muted">{detail.httpStatus}</span> : null}
                    </Space>
                  ),
                },
                {
                  key: 'stream',
                  label: '类型',
                  children: detail.stream ? '流式' : '非流式',
                },
                { key: 'durationMs', label: '耗时', children: `${detail.durationMs} ms` },
              ]}
            />
            <div className="settings-row">
              <span className="meta-label">错误信息</span>
              {detail.errorSummary ? (
                <Typography.Paragraph className="code-block" copyable={{ text: detail.errorSummary }}>
                  {detail.errorSummary}
                </Typography.Paragraph>
              ) : (
                <Typography.Text type="secondary">无错误</Typography.Text>
              )}
            </div>
          </Space>
        )}
      </Drawer>
    </div>
  );
}
