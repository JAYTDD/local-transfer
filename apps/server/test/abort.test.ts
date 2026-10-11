import { afterEach, describe, expect, it } from 'vitest';

import { startFakeUpstream, seedChannel, startGateway, type FakeUpstream, type GatewayContext } from './helpers.js';

let gateway: GatewayContext | undefined;
let upstream: FakeUpstream | undefined;

afterEach(async () => {
  await gateway?.close();
  await upstream?.close();
  gateway = undefined;
  upstream = undefined;
});

describe('client disconnect', () => {
  it('aborts the active upstream request and records an aborted log', async () => {
    upstream = await startFakeUpstream((_call, _request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(
        `data: ${JSON.stringify({ id: 'c1', model: 'upstream', choices: [{ index: 0, delta: { content: 'one' }, finish_reason: null }] })}\n\n`,
      );
      // Keep the upstream open until the client disconnects.
    });
    gateway = await startGateway();
    seedChannel(gateway.repository, {
      name: 'OpenAI',
      protocol: 'openai',
      baseUrl: upstream.baseUrl,
      models: ['virtual'],
    });

    const abort = new AbortController();
    const response = await fetch(`${gateway.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${gateway.gatewayToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model: 'virtual', messages: [{ role: 'user', content: 'hello' }], stream: true }),
      signal: abort.signal,
    });
    const reader = response.body!.getReader();
    await reader.read();
    abort.abort();
    await reader.cancel().catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(upstream.calls[0]?.aborted).toBe(true);
    const logs = gateway.repository.listLogs({ limit: 10, offset: 0 });
    expect(logs[0]).toMatchObject({ status: 'aborted', stream: true });
  });
});
