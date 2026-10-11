import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App as AntApp } from 'antd';
import type { ReactNode } from 'react';

import { getData, mutateData } from './api.js';
import { ChannelsPage } from './pages/ChannelsPage.js';
import { LogsPage } from './pages/LogsPage.js';
import { SettingsPage } from './pages/SettingsPage.js';

vi.mock('./api.js', () => ({
  getData: vi.fn(),
  mutateData: vi.fn(),
}));

const channel = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Alpha',
  protocol: 'openai' as const,
  baseUrl: 'https://alpha.test/v1',
  apiKeyMasked: '****test',
  defaultMaxTokens: 4096,
  enabled: true,
  models: ['m1', 'm2'],
  position: 0,
  createdAt: 1,
  updatedAt: 1,
};

function renderPage(page: ReactNode) {
  return render(<AntApp>{page}</AntApp>);
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('admin pages', () => {
  it('renders channels and toggles a channel', async () => {
    vi.mocked(getData).mockResolvedValue([channel]);
    vi.mocked(mutateData).mockResolvedValue({});
    renderPage(<ChannelsPage token="admin" />);
    expect(await screen.findByText('Alpha')).toBeInTheDocument();
    expect(screen.getByLabelText('复制 Alpha 接入地址')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('switch'));
    await waitFor(() =>
      expect(mutateData).toHaveBeenCalledWith(
        `/api/admin/channels/${channel.id}`,
        'admin',
        'PATCH',
        { enabled: false },
      ),
    );
  });

  it('applies a channel preset and duplicates a channel', async () => {
    vi.mocked(getData).mockResolvedValue([channel]);
    vi.mocked(mutateData).mockResolvedValue({});
    renderPage(<ChannelsPage token="admin" />);

    fireEvent.click(await screen.findByLabelText('复制 Alpha'));
    await waitFor(() =>
      expect(mutateData).toHaveBeenCalledWith(
        `/api/admin/channels/${channel.id}/duplicate`,
        'admin',
        'POST',
      ),
    );

    fireEvent.click(screen.getByRole('button', { name: /新建渠道/ }));
    fireEvent.mouseDown(screen.getByRole('combobox', { name: '渠道预设' }));
    fireEvent.click(await screen.findByTitle('DeepSeek'));
    await waitFor(() =>
      expect(screen.getByPlaceholderText('https://api.example.com/v1')).toHaveValue(
        'https://api.deepseek.com/v1',
      ),
    );
  }, 10000);

  it('renders channel models and submits them when saving', async () => {
    vi.mocked(getData).mockResolvedValue([channel]);
    vi.mocked(mutateData).mockResolvedValue({});
    renderPage(<ChannelsPage token="admin" />);
    expect(await screen.findByText('m1')).toBeInTheDocument();
    expect(screen.getByText('m2')).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('编辑 Alpha'));
    fireEvent.click(await screen.findByRole('button', { name: /保\s*存/ }));
    await waitFor(() =>
      expect(mutateData).toHaveBeenCalledWith(
        `/api/admin/channels/${channel.id}`,
        'admin',
        'PUT',
        expect.objectContaining({ models: ['m1', 'm2'] }),
      ),
    );
  });

  it('tests a channel from the card', async () => {
    vi.mocked(getData).mockResolvedValue([channel]);
    vi.mocked(mutateData).mockResolvedValue({
      ok: true,
      latencyMs: 12,
      httpStatus: 200,
      errorSummary: null,
    });
    renderPage(<ChannelsPage token="admin" />);
    fireEvent.click(await screen.findByLabelText('测试 Alpha'));
    await waitFor(() =>
      expect(mutateData).toHaveBeenCalledWith(
        `/api/admin/channels/${channel.id}/test`,
        'admin',
        'POST',
        {},
      ),
    );
  });

  it('renders channels in position order', async () => {
    const beta = {
      ...channel,
      id: '22222222-2222-4222-8222-222222222222',
      name: 'Beta',
      models: [],
      position: 1,
    };
    vi.mocked(getData).mockResolvedValue([channel, beta]);
    const { container } = renderPage(<ChannelsPage token="admin" />);
    await screen.findByText('Alpha');
    const ids = [...container.querySelectorAll('[data-channel-id]')].map((node) =>
      node.getAttribute('data-channel-id'),
    );
    expect(ids).toEqual([channel.id, beta.id]);
  });

  it('renders logs', async () => {
    vi.mocked(getData).mockImplementation(async (path: string) => {
      if (path.startsWith('/api/admin/logs')) {
        return [
          {
            id: 1,
            createdAt: 1,
            virtualModel: 'virtual',
            channelId: channel.id,
            channelName: 'Alpha',
            protocol: 'openai',
            upstreamModel: 'upstream',
            stream: false,
            status: 'ok',
            httpStatus: 200,
            durationMs: 10,
            errorSummary: null,
          },
        ];
      }
      return [channel];
    });
    renderPage(<LogsPage token="admin" />);
    expect(await screen.findByText('virtual')).toBeInTheDocument();
    expect(screen.getByText('Alpha')).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: '模型' })).toBeInTheDocument();
  });

  it('opens log details in a drawer', async () => {
    vi.mocked(getData).mockImplementation(async (path: string) => {
      if (path.startsWith('/api/admin/logs')) {
        return [
          {
            id: 7,
            createdAt: 1,
            virtualModel: 'virtual',
            channelId: channel.id,
            channelName: 'Alpha',
            protocol: 'openai',
            upstreamModel: 'upstream',
            stream: true,
            status: 'upstream_error',
            httpStatus: 500,
            durationMs: 42,
            errorSummary: 'upstream failed: 500',
          },
        ];
      }
      return [channel];
    });
    renderPage(<LogsPage token="admin" />);
    fireEvent.click(await screen.findByLabelText('查看日志 7'));
    expect(await screen.findByText('请求详情')).toBeInTheDocument();
    expect((await screen.findAllByText('upstream failed: 500')).length).toBeGreaterThanOrEqual(2);
  });

  it('renders settings and client access info', async () => {
    vi.mocked(getData).mockImplementation(async (path: string) => {
      if (path === '/api/admin/settings') {
        return {
          gatewayToken: 'gateway-token',
          connectTimeoutMs: 10000,
          streamIdleTimeoutMs: 60000,
        };
      }
      return [channel];
    });
    renderPage(<SettingsPage token="admin" />);
    expect(await screen.findByText('网关 Bearer Token')).toBeInTheDocument();
    expect(screen.getByText('流式空闲超时（毫秒）')).toBeInTheDocument();
    expect(await screen.findByText('客户端接入')).toBeInTheDocument();
    expect(screen.getByText('gateway-token')).toBeInTheDocument();
    expect(screen.getByText('m1')).toBeInTheDocument();
    expect(screen.getByText('m2')).toBeInTheDocument();
    expect(await screen.findByText('渠道接入地址')).toBeInTheDocument();
    expect(screen.getByText(/curl .*\/v1\/channels\/.*\/chat\/completions/)).toBeInTheDocument();
  });
});
