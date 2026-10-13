import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App as AntApp } from 'antd';
import type { ReactNode } from 'react';

import { getData, mutateData } from './api.js';
import { ChannelsPage } from './pages/ChannelsPage.js';
import { LogsPage } from './pages/LogsPage.js';
import { RelayPage } from './pages/RelayPage.js';
import { SettingsPage } from './pages/SettingsPage.js';
import WorkBuddyPage from './relay-panel/pages/WorkBuddyPage.jsx';

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
  modelMap: {},
  extraKeyCount: 0,
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
  vi.unstubAllGlobals();
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
  }, 10000);

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
      if (path === '/api/admin/relay') {
        return {
          enabled: false,
          channels: { trae: false, workbuddy: false, qoder: false },
          ready: false,
          prefixes: [],
        };
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
      if (path === '/api/admin/relay') {
        return {
          enabled: false,
          channels: { trae: false, workbuddy: false, qoder: false },
          ready: false,
          prefixes: [],
        };
      }
      return [channel];
    });
    renderPage(<LogsPage token="admin" />);
    fireEvent.click(await screen.findByLabelText('查看日志 7'));
    expect(await screen.findByText('请求详情')).toBeInTheDocument();
    expect((await screen.findAllByText('upstream failed: 500')).length).toBeGreaterThanOrEqual(2);
  });

  it('lists relay channels in the log channel filter', async () => {
    vi.mocked(getData).mockImplementation(async (path: string) => {
      if (path.startsWith('/api/admin/logs')) return [];
      if (path === '/api/admin/relay') {
        return {
          enabled: true,
          channels: { trae: true, workbuddy: false, qoder: false },
          ready: true,
          prefixes: [{ prefix: 'trae', label: 'Trae 国内版', channel: 'trae', models: 3 }],
        };
      }
      return [channel];
    });
    renderPage(<LogsPage token="admin" />);
    fireEvent.mouseDown(screen.getAllByRole('combobox')[0]!);
    expect(await screen.findByTitle('Trae 国内版')).toBeInTheDocument();
  });

  it('renders relay tabs without the merged log tab', async () => {
    vi.mocked(getData).mockResolvedValue({
      enabled: true,
      channels: { trae: false, workbuddy: false, qoder: false },
      ready: true,
      prefixes: [],
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ ok: true, endpoint: 'http://127.0.0.1:8787/v1', providers: [] }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
      ),
    );
    renderPage(<RelayPage token="admin" />);
    expect(await screen.findByText('总览')).toBeInTheDocument();
    expect(screen.getByText('设置')).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: '日志' })).not.toBeInTheDocument();
  });

  it('toggles a workbuddy model without refetching the whole document', async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        calls.push(`${init?.method ?? 'GET'} ${url}`);
        const body = url.includes('/panel/workbuddy/control')
          ? { state: 'updated', disabledModels: ['m1'] }
          : {
              variants: {
                cn: {
                  status: 'signed-in',
                  variant: 'cn',
                  models: [{ id: 'm1', name: 'M1' }],
                  disabledModels: [],
                  maximumContext: { supported: false },
                  probeConsent: false,
                },
              },
            };
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }),
    );
    renderPage(<WorkBuddyPage variant="cn" onVariant={() => {}} onChannelChanged={() => {}} />);
    fireEvent.click(await screen.findByRole('switch', { name: '启用 m1' }));
    await waitFor(() =>
      expect(screen.getByRole('switch', { name: '启用 m1' })).toHaveAttribute('aria-checked', 'false'),
    );
    expect(calls.filter((call) => call.startsWith('GET') && call.includes('/panel/workbuddy?'))).toHaveLength(1);
    expect(calls.some((call) => call.startsWith('POST') && call.includes('/panel/workbuddy/control'))).toBe(true);
  });

  it('keeps the workbuddy pane mounted when toggling a model inside relay tabs', async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        calls.push(`${init?.method ?? 'GET'} ${url}`);
        let body: unknown = {};
        if (url.includes('/panel/workbuddy/control')) {
          body = { state: 'updated', disabledModels: ['m1'] };
        } else if (url.includes('/panel/workbuddy')) {
          body = {
            variants: {
              cn: {
                status: 'signed-in',
                variant: 'cn',
                models: [{ id: 'm1', name: 'M1' }],
                disabledModels: [],
                maximumContext: { supported: false },
                probeConsent: false,
              },
            },
          };
        } else if (url.includes('/panel/health')) {
          body = { ok: true, endpoint: 'http://127.0.0.1:8787/v1', providers: [] };
        } else if (url.includes('/panel/trae')) {
          body = { regions: { cn: { status: 'signed-out' }, ai: { status: 'signed-out' } } };
        } else if (url.includes('/panel/qoder')) {
          body = { variants: { cn: { status: 'signed-out' }, global: { status: 'signed-out' } } };
        }
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }),
    );
    vi.mocked(getData).mockImplementation(async (path: string) => {
      if (path === '/api/admin/relay') {
        return { enabled: true, channels: { trae: false, workbuddy: true, qoder: false }, ready: true, prefixes: [] };
      }
      return [];
    });
    renderPage(<RelayPage token="admin" />);
    fireEvent.click(await screen.findByRole('tab', { name: 'WorkBuddy' }));
    fireEvent.click(await screen.findByRole('switch', { name: '启用 m1' }));
    await waitFor(() =>
      expect(screen.getByRole('switch', { name: '启用 m1' })).toHaveAttribute('aria-checked', 'false'),
    );
    expect(calls.filter((call) => call.startsWith('GET') && call.includes('/panel/workbuddy?'))).toHaveLength(1);
  }, 10000);

  it('renders settings and client access info', async () => {
    vi.mocked(getData).mockImplementation(async (path: string) => {
      if (path === '/api/admin/settings') {
        return {
          gatewayToken: 'gateway-token',
          connectTimeoutMs: 10000,
          streamIdleTimeoutMs: 60000,
          logRetentionDays: 0,
          launchAtLogin: false,
          launchAtLoginSupported: true,
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
