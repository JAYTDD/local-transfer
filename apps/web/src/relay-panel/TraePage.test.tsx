import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App as AntApp } from 'antd';

import TraePage from './pages/TraePage.jsx';
import { clearDocumentCache } from './hooks.js';

function jsonResponse(body: unknown) {
  return { ok: true, text: async () => JSON.stringify(body) };
}

function traeDocument(region: 'cn' | 'ai', extra: Record<string, unknown> = {}) {
  const cn = region === 'cn';
  return {
    regions: {
      [region]: {
        status: 'signed-in',
        accountName: 'bound',
        prefs: {
          enabled: true,
          contextBudgets: {},
          modelSelection: [],
          imageSelection: [],
        },
        models: [
          { id: 'wide', name: 'Wide', contextWindow: 200000, maxContextWindow: 1_000_000, creditMultiplier: 0.1 },
          { id: 'plain', name: 'Plain', contextWindow: 128000 },
        ],
        credits: cn
          ? {
              available: 12,
              consumed: 1,
              workAvailable: 0,
              generalAvailable: 12,
              accounts: [{ displayDesc: '快到期', remain: 3, size: 3, expiresAtMs: 1_700_000_003_600_000 }],
              expiry: {
                expired: { total: 0, packs: 0 },
                within24h: { total: 3, packs: 1, earliestExpiresAtMs: 1_700_000_003_600_000 },
                within3d: { total: 3, packs: 1, earliestExpiresAtMs: 1_700_000_003_600_000 },
                within7d: { total: 3, packs: 1, earliestExpiresAtMs: 1_700_000_003_600_000 },
              },
            }
          : undefined,
        checkin: cn ? { checkedIn: false, didCheckedIn: true, credits: 5, enabled: true } : undefined,
        payStatus: cn ? undefined : { payIdentityStr: 'Pro', hasPackage: true, inTrial: false },
        appLogin: cn ? { id: 'live', accountName: 'desktop' } : undefined,
        ...extra,
      },
    },
  };
}

afterEach(() => {
  cleanup();
});

describe('Trae 通道页', () => {
  const posts: unknown[] = [];

  beforeEach(() => {
    posts.length = 0;
    clearDocumentCache();
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const target = String(url);
      if (target.includes('/trae/control')) {
        posts.push(JSON.parse(String(init?.body ?? '{}')));
        const action = posts.at(-1) as { action?: string };
        if (action.action === 'test-models') {
          return jsonResponse({
            state: 'updated',
            results: [{ id: 'wide', verdict: 'available', detail: 'ok' }, { id: 'plain', verdict: 'rate_limited', detail: 'slow' }],
          });
        }
        return jsonResponse({ state: 'updated' });
      }
      const region = new URL(target, 'http://127.0.0.1').searchParams.get('region') === 'ai' ? 'ai' : 'cn';
      return jsonResponse(traeDocument(region));
    }));
  });

  it('有 Max 档时用下拉选择，并按插件规则提交窗口', async () => {
    render(<AntApp><TraePage region="cn" onRegion={() => undefined} /></AntApp>);
    const context = await screen.findByRole('combobox', { name: '上下文 wide' });
    expect(context).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: '上下文 plain' })).not.toBeInTheDocument();
    expect(screen.getByText('128K')).toBeInTheDocument();

    fireEvent.mouseDown(context);
    fireEvent.click(await screen.findByTitle('1M Max'));
    await waitFor(() => expect(posts).toContainEqual({
      action: 'set-context-budgets',
      budgets: { wide: 1_000_000 },
    }));
  });

  it('从 Max 切回默认时清掉该模型的预算', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const target = String(url);
      if (target.includes('/trae/control')) {
        posts.push(JSON.parse(String(init?.body ?? '{}')));
        return jsonResponse({ state: 'updated' });
      }
      const doc = traeDocument('cn');
      const region = (doc.regions as { cn: { prefs: { contextBudgets: Record<string, number> } } }).cn;
      region.prefs.contextBudgets = { wide: 1_000_000 };
      return jsonResponse(doc);
    }));
    render(<AntApp><TraePage region="cn" onRegion={() => undefined} /></AntApp>);
    fireEvent.mouseDown(await screen.findByRole('combobox', { name: '上下文 wide' }));
    fireEvent.click(await screen.findByTitle('200K'));
    await waitFor(() => expect(posts).toContainEqual({
      action: 'set-context-budgets',
      budgets: {},
    }));
  });

  it('展示积分到期、换登录、设备已签和模型测试结果', async () => {
    render(<AntApp><TraePage region="cn" onRegion={() => undefined} /></AntApp>);
    expect(await screen.findByText(/24 小时内到期/)).toBeInTheDocument();
    expect(screen.getByText(/到期 /)).toBeInTheDocument();
    expect(screen.getByText(/本设备今日已签，这个账号还没领到/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '本设备已用过' })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: '改用 desktop' }));
    await waitFor(() => expect(posts).toContainEqual({
      action: 'select-account',
      accountId: 'live',
    }));

    fireEvent.click(screen.getByRole('button', { name: '测试已启用' }));
    await waitFor(() => expect(posts).toContainEqual({
      action: 'test-models',
      models: ['wide', 'plain'],
    }));
    expect(await screen.findByText('可用')).toBeInTheDocument();
    expect(screen.getByText('限流')).toBeInTheDocument();
  });

  it('国际版显示套餐名', async () => {
    render(<AntApp><TraePage region="ai" onRegion={() => undefined} /></AntApp>);
    expect(await screen.findByText('Pro')).toBeInTheDocument();
    expect(screen.queryByText(/24 小时内到期/)).not.toBeInTheDocument();
  });
});
