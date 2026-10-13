import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

import { App } from './App.js';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('admin shell', () => {
  it('renders navigation without an admin token', async () => {
    window.history.pushState({}, '', '/admin/');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/api/admin/channels')) {
          return new Response(JSON.stringify({ data: [] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }),
    );
    render(<App />);
    expect(await screen.findByRole('heading', { name: '渠道' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: '模型' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: '用量' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: '用量' })).toBeInTheDocument();
    expect(screen.getByText('日志')).toBeInTheDocument();
    expect(screen.getByText('设置')).toBeInTheDocument();
  });
});
