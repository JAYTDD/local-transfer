import { afterEach, describe, expect, it } from 'vitest';

import { startFakeUpstream, startGateway, type GatewayContext, type FakeUpstream } from './helpers.js';

let gateway: GatewayContext | undefined;
let upstream: FakeUpstream | undefined;

afterEach(async () => {
  await gateway?.close();
  await upstream?.close();
  gateway = undefined;
  upstream = undefined;
});

function adminHeaders(): HeadersInit {
  return { 'content-type': 'application/json' };
}

describe('admin api', () => {
  it('exposes a local management session without an admin token', async () => {
    gateway = await startGateway();
    const response = await fetch(`${gateway.baseUrl}/api/admin/session`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, authRequired: false });
  });

  it('creates, updates, disables, lists, and deletes channels', async () => {
    gateway = await startGateway();
    const headers = adminHeaders();
    const created = await fetch(`${gateway.baseUrl}/api/admin/channels`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        name: 'Alpha',
        protocol: 'openai',
        baseUrl: 'https://example.test/v1/',
        apiKey: 'sk-12345678',
        defaultMaxTokens: 1000,
        enabled: true,
        models: ['model-a', 'model-a', 'model-b'],
      }),
    });
    expect(created.status).toBe(201);
    const createdBody = await created.json();
    const id = createdBody.data.id as string;
    expect(createdBody.data.baseUrl).toBe('https://example.test/v1');
    expect(createdBody.data.apiKeyMasked).toBe('****5678');
    expect(createdBody.data.models).toEqual(['model-a', 'model-b']);
    expect(createdBody.data.position).toBe(0);

    const patched = await fetch(`${gateway.baseUrl}/api/admin/channels/${id}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ enabled: false }),
    });
    expect(patched.status).toBe(200);
    const patchedBody = await patched.json();
    expect(patchedBody.data.enabled).toBe(false);
    expect(patchedBody.data.models).toEqual(['model-a', 'model-b']);

    const deleted = await fetch(`${gateway.baseUrl}/api/admin/channels/${id}`, {
      method: 'DELETE',
      headers: {},
    });
    const deletedText = await deleted.text();
    expect(deleted.status, deletedText).toBe(200);
  });

  it('accepts the responses upstream protocol', async () => {
    gateway = await startGateway();
    const response = await fetch(`${gateway.baseUrl}/api/admin/channels`, {
      method: 'POST',
      headers: adminHeaders(),
      body: JSON.stringify({
        name: 'Responses',
        protocol: 'responses',
        baseUrl: 'https://responses.test/v1',
        apiKey: 'sk-responses',
        defaultMaxTokens: 2048,
        enabled: true,
        models: ['gpt-5'],
      }),
    });
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.data.protocol).toBe('responses');
    expect(body.data.models).toEqual(['gpt-5']);
  });

  it('duplicates a channel and reports missing or conflicting sources', async () => {
    gateway = await startGateway();
    const source = gateway.repository.createChannel({
      name: 'Alpha',
      protocol: 'openai',
      baseUrl: 'https://alpha.test/v1',
      apiKey: 'sk-12345678',
      defaultMaxTokens: 1000,
      enabled: false,
      models: ['m1', 'm2'],
    });

    const duplicated = await fetch(`${gateway.baseUrl}/api/admin/channels/${source.id}/duplicate`, {
      method: 'POST',
      headers: {},
    });
    expect(duplicated.status).toBe(201);
    const body = await duplicated.json();
    expect(body.data.name).toBe('Alpha-copy');
    expect(body.data.apiKeyMasked).toBe('****5678');
    expect(body.data.enabled).toBe(false);
    expect(body.data.models).toEqual(['m1', 'm2']);
    expect(body.data.position).toBe(1);

    const conflict = await fetch(`${gateway.baseUrl}/api/admin/channels/${source.id}/duplicate`, {
      method: 'POST',
      headers: {},
    });
    expect(conflict.status).toBe(409);

    const missing = await fetch(
      `${gateway.baseUrl}/api/admin/channels/00000000-0000-4000-8000-000000000000/duplicate`,
      { method: 'POST', headers: {} },
    );
    expect(missing.status).toBe(404);
  });

  it('reorders channels and rejects mismatched id lists', async () => {
    gateway = await startGateway();
    const first = gateway.repository.createChannel({
      name: 'A',
      protocol: 'openai',
      baseUrl: 'https://a.test/v1',
      apiKey: 'sk-a',
      defaultMaxTokens: 100,
      enabled: true,
      models: ['m1'],
    });
    const second = gateway.repository.createChannel({
      name: 'B',
      protocol: 'anthropic',
      baseUrl: 'https://b.test/v1',
      apiKey: 'sk-b',
      defaultMaxTokens: 200,
      enabled: true,
      models: ['m1'],
    });

    const reordered = await fetch(`${gateway.baseUrl}/api/admin/channels/order`, {
      method: 'PUT',
      headers: adminHeaders(),
      body: JSON.stringify({ ids: [second.id, first.id] }),
    });
    expect(reordered.status).toBe(200);
    const body = await reordered.json();
    expect(body.data.map((channel: { name: string }) => channel.name)).toEqual(['B', 'A']);

    const invalid = await fetch(`${gateway.baseUrl}/api/admin/channels/order`, {
      method: 'PUT',
      headers: adminHeaders(),
      body: JSON.stringify({ ids: [first.id] }),
    });
    expect(invalid.status).toBe(400);
  });

  it('tests a channel with a real minimal request without writing logs', async () => {
    upstream = await startFakeUpstream((_call, _request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(
        JSON.stringify({
          id: 'chatcmpl-test',
          object: 'chat.completion',
          choices: [],
        }),
      );
    });
    gateway = await startGateway();
    const channel = gateway.repository.createChannel({
      name: 'Testable',
      protocol: 'openai',
      baseUrl: upstream.baseUrl,
      apiKey: 'sk-test',
      defaultMaxTokens: 4096,
      enabled: true,
      models: ['m1'],
    });
    const response = await fetch(`${gateway.baseUrl}/api/admin/channels/${channel.id}/test`, {
      method: 'POST',
      headers: adminHeaders(),
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.ok).toBe(true);
    expect(body.data.httpStatus).toBe(200);
    expect(body.data.latencyMs).toBeGreaterThanOrEqual(0);
    expect(JSON.parse(upstream.calls[0]!.body)).toMatchObject({
      model: 'm1',
      max_tokens: 16,
      messages: [{ role: 'user', content: 'ping' }],
    });
    expect(gateway.repository.listLogs({ limit: 10, offset: 0 })).toHaveLength(0);
  });

  it('reports channel test failures and rejects channels without models', async () => {
    upstream = await startFakeUpstream((_call, _request, response) => {
      response.statusCode = 500;
      response.end('boom');
    });
    gateway = await startGateway();
    const failing = gateway.repository.createChannel({
      name: 'Failing',
      protocol: 'openai',
      baseUrl: upstream.baseUrl,
      apiKey: 'sk-test',
      defaultMaxTokens: 4096,
      enabled: true,
      models: ['m1'],
    });
    const failed = await fetch(`${gateway.baseUrl}/api/admin/channels/${failing.id}/test`, {
      method: 'POST',
      headers: adminHeaders(),
      body: JSON.stringify({}),
    });
    expect(failed.status).toBe(200);
    const failedBody = await failed.json();
    expect(failedBody.data.ok).toBe(false);
    expect(failedBody.data.httpStatus).toBe(500);
    expect(failedBody.data.errorSummary).toBe('boom');

    const empty = gateway.repository.createChannel({
      name: 'Empty',
      protocol: 'openai',
      baseUrl: 'https://empty.test/v1',
      apiKey: 'sk-test',
      defaultMaxTokens: 4096,
      enabled: true,
      models: [],
    });
    const rejected = await fetch(`${gateway.baseUrl}/api/admin/channels/${empty.id}/test`, {
      method: 'POST',
      headers: adminHeaders(),
      body: JSON.stringify({}),
    });
    expect(rejected.status).toBe(400);
  });

  it('removes the legacy model management endpoints', async () => {
    gateway = await startGateway();
    const response = await fetch(`${gateway.baseUrl}/api/admin/models`);
    expect(response.status).toBe(404);
  });

  it('pulls models without persisting them', async () => {
    upstream = await startFakeUpstream((_call, _request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ data: [{ id: 'm1', name: 'Model 1' }] }));
    });
    gateway = await startGateway();
    const response = await fetch(`${gateway.baseUrl}/api/admin/channels/pull-models`, {
      method: 'POST',
      headers: adminHeaders(),
      body: JSON.stringify({
        protocol: 'openai',
        baseUrl: upstream.baseUrl,
        apiKey: 'sk-secret',
      }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.models).toEqual([{ id: 'm1', displayName: 'Model 1' }]);
    expect(body.data.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('updates settings immediately', async () => {
    gateway = await startGateway();
    const response = await fetch(`${gateway.baseUrl}/api/admin/settings`, {
      method: 'PUT',
      headers: adminHeaders(),
      body: JSON.stringify({ gatewayToken: 'new-gateway-token', connectTimeoutMs: 4321 }),
    });
    expect(response.status).toBe(200);
    const updated = await response.json();
    expect(updated.data.gatewayToken).toBe('new-gateway-token');
    expect(updated.data.connectTimeoutMs).toBe(4321);

    const unauthorized = await fetch(`${gateway.baseUrl}/v1/models`, {
      headers: { authorization: `Bearer ${gateway.gatewayToken}` },
    });
    expect(unauthorized.status).toBe(401);
    const authorized = await fetch(`${gateway.baseUrl}/v1/models`, {
      headers: { authorization: 'Bearer new-gateway-token' },
    });
    expect(authorized.status).toBe(200);
  });
});
