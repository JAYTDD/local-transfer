import { afterEach, describe, expect, it, vi } from 'vitest';

import { startFakeUpstream, seedChannel, startGateway, type GatewayContext, type FakeUpstream } from './helpers.js';

let gateway: GatewayContext | undefined;
let upstream: FakeUpstream | undefined;
let secondUpstream: FakeUpstream | undefined;

afterEach(async () => {
  await gateway?.close();
  await upstream?.close();
  await secondUpstream?.close();
  gateway = undefined;
  upstream = undefined;
  secondUpstream = undefined;
});

function chatHeaders(token: string): HeadersInit {
  return { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
}

describe('OpenAI proxy', () => {
  it('proxies a non-stream OpenAI request and lists models', async () => {
    upstream = await startFakeUpstream((call, _request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(
        JSON.stringify({
          id: 'chatcmpl-1',
          object: 'chat.completion',
          model: JSON.parse(call.body).model,
          choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );
    });
    gateway = await startGateway();
    seedChannel(gateway.repository, {
      name: 'OpenAI',
      protocol: 'openai',
      baseUrl: upstream.baseUrl,
      models: ['virtual'],
    });

    const models = await fetch(`${gateway.baseUrl}/v1/models`, {
      headers: { authorization: `Bearer ${gateway.gatewayToken}` },
    });
    expect((await models.json()).data.map((model: { id: string }) => model.id)).toEqual(['virtual']);

    const response = await fetch(`${gateway.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        ...chatHeaders(gateway.gatewayToken),
        'x-opencode-session': 'session-1',
      },
      body: JSON.stringify({
        model: 'virtual',
        messages: [{ role: 'user', content: 'hello' }],
      }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.model).toBe('virtual');
    expect(body.choices[0].message.content).toBe('hi');
    expect(JSON.parse(upstream.calls[0]!.body).model).toBe('virtual');
    expect(upstream.calls[0]!.headers['x-opencode-session']).toBe('session-1');
    expect(upstream.calls[0]!.headers.authorization).toBe('Bearer sk-test');
  });

  it('converts Anthropic non-stream responses to chat completions', async () => {
    upstream = await startFakeUpstream((_call, _request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(
        JSON.stringify({
          id: 'msg_1',
          content: [{ type: 'text', text: 'claude reply' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 2, output_tokens: 3 },
        }),
      );
    });
    gateway = await startGateway();
    seedChannel(gateway.repository, {
      name: 'Claude',
      protocol: 'anthropic',
      baseUrl: upstream.baseUrl,
      models: ['virtual'],
    });
    const response = await fetch(`${gateway.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: chatHeaders(gateway.gatewayToken),
      body: JSON.stringify({
        model: 'virtual',
        messages: [{ role: 'system', content: 'be brief' }, { role: 'user', content: 'hello' }],
      }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.choices[0].message.content).toBe('claude reply');
    expect(body.usage.total_tokens).toBe(5);
    expect(JSON.parse(upstream.calls[0]!.body).system).toEqual([{ type: 'text', text: 'be brief' }]);
  });

  it('converts Responses non-stream responses to chat completions', async () => {
    upstream = await startFakeUpstream((call, _request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(
        JSON.stringify({
          id: 'resp_1',
          created_at: 123,
          status: 'completed',
          output: [
            {
              type: 'message',
              content: [{ type: 'output_text', text: 'responses reply' }],
            },
          ],
          usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 },
        }),
      );
    });
    gateway = await startGateway();
    seedChannel(gateway.repository, {
      name: 'Responses',
      protocol: 'responses',
      baseUrl: upstream.baseUrl,
      models: ['virtual'],
    });
    const response = await fetch(`${gateway.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: chatHeaders(gateway.gatewayToken),
      body: JSON.stringify({
        model: 'virtual',
        messages: [{ role: 'user', content: 'hello' }],
      }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.choices[0].message.content).toBe('responses reply');
    expect(body.usage.total_tokens).toBe(5);
    expect(upstream.calls[0]?.url).toBe('/v1/responses');
    expect(JSON.parse(upstream.calls[0]!.body).input).toEqual([{ role: 'user', content: 'hello' }]);
  });

  it('returns the channel error without switching to another channel', async () => {
    upstream = await startFakeUpstream((_call, _request, response) => {
      response.statusCode = 429;
      response.end('rate limited');
    });
    secondUpstream = await startFakeUpstream((_call, _request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(
        JSON.stringify({
          id: 'chatcmpl-2',
          object: 'chat.completion',
          model: 'second-model',
          choices: [{ index: 0, message: { role: 'assistant', content: 'second' }, finish_reason: 'stop' }],
        }),
      );
    });
    gateway = await startGateway();
    const first = seedChannel(gateway.repository, {
      name: 'First',
      protocol: 'openai',
      baseUrl: upstream.baseUrl,
      models: ['virtual'],
    });
    seedChannel(gateway.repository, {
      name: 'Second',
      protocol: 'openai',
      baseUrl: secondUpstream.baseUrl,
      models: ['virtual'],
    });
    const response = await fetch(`${gateway.baseUrl}/v1/channels/${first.id}/chat/completions`, {
      method: 'POST',
      headers: chatHeaders(gateway.gatewayToken),
      body: JSON.stringify({ model: 'virtual', messages: [{ role: 'user', content: 'hello' }] }),
    });
    expect(response.status).toBe(429);
    const body = await response.json();
    expect(body.error.code).toBe('upstream_error');
    expect(body.error.upstream.attempts[0]).toMatchObject({ channelName: 'First', status: 429 });
    expect(upstream.calls).toHaveLength(1);
    expect(secondUpstream.calls).toHaveLength(0);
  });

  it('rejects an ambiguous model on the global endpoint', async () => {
    gateway = await startGateway();
    seedChannel(gateway.repository, {
      name: 'First',
      protocol: 'openai',
      baseUrl: 'https://first.test/v1',
      models: ['shared'],
    });
    seedChannel(gateway.repository, {
      name: 'Second',
      protocol: 'openai',
      baseUrl: 'https://second.test/v1',
      models: ['shared'],
    });
    const response = await fetch(`${gateway.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: chatHeaders(gateway.gatewayToken),
      body: JSON.stringify({ model: 'shared', messages: [{ role: 'user', content: 'hello' }] }),
    });
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe('model_ambiguous');
  });

  it('returns a traceable error for a single channel failure', async () => {
    upstream = await startFakeUpstream((_call, _request, response) => {
      response.statusCode = 500;
      response.end('boom');
    });
    gateway = await startGateway();
    seedChannel(gateway.repository, {
      name: 'Broken',
      protocol: 'openai',
      baseUrl: upstream.baseUrl,
      models: ['virtual'],
    });
    const response = await fetch(`${gateway.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: chatHeaders(gateway.gatewayToken),
      body: JSON.stringify({ model: 'virtual', messages: [{ role: 'user', content: 'hello' }] }),
    });
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error.code).toBe('upstream_error');
    expect(body.error.upstream.attempts[0]).toMatchObject({
      channelName: 'Broken',
      protocol: 'openai',
      status: 500,
    });
  });

  it('uses the OpenAI error envelope for malformed JSON and unknown routes', async () => {
    gateway = await startGateway();
    const malformed = await fetch(`${gateway.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: chatHeaders(gateway.gatewayToken),
      body: '{"model":',
    });
    expect(malformed.status).toBe(400);
    expect((await malformed.json()).error).toMatchObject({
      code: 'invalid_json',
      type: 'invalid_request_error',
    });

    const unknown = await fetch(`${gateway.baseUrl}/v1/unknown`, {
      headers: { authorization: `Bearer ${gateway.gatewayToken}` },
    });
    expect(unknown.status).toBe(404);
    expect((await unknown.json()).error.code).toBe('not_found');
  });

  it('streams OpenAI SSE and rewrites the model', async () => {
    upstream = await startFakeUpstream((_call, _request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(`data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', model: 'upstream', choices: [] })}\n\n`);
      response.end('data: [DONE]\n\n');
    });
    gateway = await startGateway();
    seedChannel(gateway.repository, {
      name: 'OpenAI',
      protocol: 'openai',
      baseUrl: upstream.baseUrl,
      models: ['virtual'],
    });
    const response = await fetch(`${gateway.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: chatHeaders(gateway.gatewayToken),
      body: JSON.stringify({ model: 'virtual', messages: [{ role: 'user', content: 'hello' }], stream: true }),
    });
    const text = await response.text();
    expect(text).toContain('"model":"virtual"');
    expect(text).toContain('data: [DONE]');
  });

  it('converts Responses SSE to chat completion chunks', async () => {
    upstream = await startFakeUpstream((_call, _request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(
        `event: response.created\ndata: ${JSON.stringify({
          type: 'response.created',
          response: { id: 'resp_1', created_at: 123 },
        })}\n\n`,
      );
      response.write(
        `event: response.output_text.delta\ndata: ${JSON.stringify({
          type: 'response.output_text.delta',
          delta: 'hello',
        })}\n\n`,
      );
      response.end(
        `event: response.completed\ndata: ${JSON.stringify({
          type: 'response.completed',
          response: { status: 'completed' },
        })}\n\n`,
      );
    });
    gateway = await startGateway();
    seedChannel(gateway.repository, {
      name: 'Responses',
      protocol: 'responses',
      baseUrl: upstream.baseUrl,
      models: ['virtual'],
    });
    const response = await fetch(`${gateway.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: chatHeaders(gateway.gatewayToken),
      body: JSON.stringify({
        model: 'virtual',
        messages: [{ role: 'user', content: 'hello' }],
        stream: true,
      }),
    });
    const text = await response.text();
    expect(text).toContain('"object":"chat.completion.chunk"');
    expect(text).toContain('"content":"hello"');
    expect(text).toContain('data: [DONE]');
  });

  it('fails a channel-specific stream without switching when no visible chunk arrives', async () => {
    upstream = await startFakeUpstream((_call, _request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      // Keep the upstream open until the gateway aborts the connection.
    });
    secondUpstream = await startFakeUpstream((_call, _request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(`data: ${JSON.stringify({ id: 'c2', model: 'second', choices: [] })}\n\ndata: [DONE]\n\n`);
    });
    gateway = await startGateway();
    gateway.repository.updateSettings({ connectTimeoutMs: 50 });
    const slow = seedChannel(gateway.repository, {
      name: 'Slow',
      protocol: 'openai',
      baseUrl: upstream.baseUrl,
      models: ['virtual'],
    });
    seedChannel(gateway.repository, {
      name: 'Fast',
      protocol: 'openai',
      baseUrl: secondUpstream.baseUrl,
      models: ['virtual'],
    });
    const response = await fetch(`${gateway.baseUrl}/v1/channels/${slow.id}/chat/completions`, {
      method: 'POST',
      headers: chatHeaders(gateway.gatewayToken),
      body: JSON.stringify({ model: 'virtual', messages: [{ role: 'user', content: 'hello' }], stream: true }),
    });
    expect(response.status).toBe(502);
    expect((await response.json()).error.code).toBe('upstream_error');
    expect(secondUpstream.calls).toHaveLength(0);
    await vi.waitFor(() => expect(upstream!.calls[0]?.aborted).toBe(true));
  });

  it('ends a channel-specific stream with an error after the first visible chunk', async () => {
    upstream = await startFakeUpstream((_call, _request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(
        `data: ${JSON.stringify({ id: 'c1', model: 'first', choices: [{ index: 0, delta: { content: 'first' }, finish_reason: null }] })}\n\n`,
      );
      // Keep the upstream open until the gateway applies the idle timeout.
    });
    secondUpstream = await startFakeUpstream((_call, _request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end('data: [DONE]\n\n');
    });
    gateway = await startGateway();
    gateway.repository.updateSettings({ streamIdleTimeoutMs: 50 });
    const locked = seedChannel(gateway.repository, {
      name: 'Locked',
      protocol: 'openai',
      baseUrl: upstream.baseUrl,
      models: ['virtual'],
    });
    seedChannel(gateway.repository, {
      name: 'Unused',
      protocol: 'openai',
      baseUrl: secondUpstream.baseUrl,
      models: ['virtual'],
    });
    const response = await fetch(`${gateway.baseUrl}/v1/channels/${locked.id}/chat/completions`, {
      method: 'POST',
      headers: chatHeaders(gateway.gatewayToken),
      body: JSON.stringify({ model: 'virtual', messages: [{ role: 'user', content: 'hello' }], stream: true }),
    });
    const text = await response.text();
    expect(text).toContain('"content":"first"');
    expect(text).toContain('"error"');
    expect(secondUpstream.calls).toHaveLength(0);
  });

  it('lists the union of channel models including disabled channels', async () => {
    gateway = await startGateway();
    seedChannel(gateway.repository, {
      name: 'Enabled',
      protocol: 'openai',
      baseUrl: 'https://enabled.test/v1',
      models: ['b-model', 'shared'],
    });
    seedChannel(gateway.repository, {
      name: 'Disabled',
      protocol: 'anthropic',
      baseUrl: 'https://disabled.test/v1',
      enabled: false,
      models: ['a-model', 'shared'],
    });
    const response = await fetch(`${gateway.baseUrl}/v1/models`, {
      headers: { authorization: `Bearer ${gateway.gatewayToken}` },
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.map((model: { id: string }) => model.id)).toEqual(['a-model', 'b-model', 'shared']);
  });

  it('distinguishes unknown models from models with no enabled channel', async () => {
    gateway = await startGateway();
    seedChannel(gateway.repository, {
      name: 'Disabled',
      protocol: 'openai',
      baseUrl: 'https://disabled.test/v1',
      enabled: false,
      models: ['configured'],
    });
    const unknown = await fetch(`${gateway.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: chatHeaders(gateway.gatewayToken),
      body: JSON.stringify({ model: 'missing', messages: [{ role: 'user', content: 'hello' }] }),
    });
    expect(unknown.status).toBe(404);
    expect((await unknown.json()).error.code).toBe('model_not_found');

    const unavailable = await fetch(`${gateway.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: chatHeaders(gateway.gatewayToken),
      body: JSON.stringify({ model: 'configured', messages: [{ role: 'user', content: 'hello' }] }),
    });
    expect(unavailable.status).toBe(503);
    expect((await unavailable.json()).error.code).toBe('model_unavailable');
  });

  it('routes channel-specific endpoints independently of channel order', async () => {
    upstream = await startFakeUpstream((_call, _request, response) => {
      response.statusCode = 500;
      response.end('first-position-failed');
    });
    secondUpstream = await startFakeUpstream((_call, _request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(
        JSON.stringify({
          id: 'chatcmpl-2',
          object: 'chat.completion',
          model: 'm',
          choices: [{ index: 0, message: { role: 'assistant', content: 'second' }, finish_reason: 'stop' }],
        }),
      );
    });
    gateway = await startGateway();
    const first = seedChannel(gateway.repository, {
      name: 'First',
      protocol: 'openai',
      baseUrl: upstream.baseUrl,
      models: ['m'],
    });
    const second = seedChannel(gateway.repository, {
      name: 'Second',
      protocol: 'openai',
      baseUrl: secondUpstream.baseUrl,
      models: ['m'],
    });
    expect(gateway.repository.reorderChannels([second.id, first.id])).toBe(true);
    const response = await fetch(`${gateway.baseUrl}/v1/channels/${second.id}/chat/completions`, {
      method: 'POST',
      headers: chatHeaders(gateway.gatewayToken),
      body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hello' }] }),
    });
    expect(response.status).toBe(200);
    expect((await response.json()).choices[0].message.content).toBe('second');
    expect(upstream.calls).toHaveLength(0);
    expect(secondUpstream.calls).toHaveLength(1);
  });

  it('lists only the selected channel models on channel endpoints', async () => {
    gateway = await startGateway();
    const first = seedChannel(gateway.repository, {
      name: 'First',
      protocol: 'openai',
      baseUrl: 'https://first.test/v1',
      models: ['a-model', 'shared'],
    });
    seedChannel(gateway.repository, {
      name: 'Second',
      protocol: 'anthropic',
      baseUrl: 'https://second.test/v1',
      models: ['b-model', 'shared'],
    });
    const response = await fetch(`${gateway.baseUrl}/v1/channels/${first.id}/models`, {
      headers: { authorization: `Bearer ${gateway.gatewayToken}` },
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.map((model: { id: string }) => model.id)).toEqual(['a-model', 'shared']);
    expect(body.data[0].owned_by).toBe('First');
  });

  it('returns channel-specific errors for missing channel, missing model, and disabled channel', async () => {
    gateway = await startGateway();
    const channel = seedChannel(gateway.repository, {
      name: 'Only',
      protocol: 'openai',
      baseUrl: 'https://only.test/v1',
      enabled: false,
      models: ['configured'],
    });
    const missingChannel = await fetch(`${gateway.baseUrl}/v1/channels/missing/chat/completions`, {
      method: 'POST',
      headers: chatHeaders(gateway.gatewayToken),
      body: JSON.stringify({ model: 'configured', messages: [{ role: 'user', content: 'hello' }] }),
    });
    expect(missingChannel.status).toBe(404);
    expect((await missingChannel.json()).error.code).toBe('channel_not_found');

    const missingModel = await fetch(`${gateway.baseUrl}/v1/channels/${channel.id}/chat/completions`, {
      method: 'POST',
      headers: chatHeaders(gateway.gatewayToken),
      body: JSON.stringify({ model: 'other', messages: [{ role: 'user', content: 'hello' }] }),
    });
    expect(missingModel.status).toBe(404);
    expect((await missingModel.json()).error.code).toBe('model_not_found');

    const disabled = await fetch(`${gateway.baseUrl}/v1/channels/${channel.id}/chat/completions`, {
      method: 'POST',
      headers: chatHeaders(gateway.gatewayToken),
      body: JSON.stringify({ model: 'configured', messages: [{ role: 'user', content: 'hello' }] }),
    });
    expect(disabled.status).toBe(503);
    expect((await disabled.json()).error.code).toBe('channel_unavailable');
  });

  it('proxies tool definitions and tool calls through an OpenAI channel', async () => {
    upstream = await startFakeUpstream((_call, _request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(
        JSON.stringify({
          id: 'chatcmpl-tool',
          object: 'chat.completion',
          model: 'm',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [
                  {
                    id: 'call_1',
                    type: 'function',
                    function: { name: 'get_weather', arguments: '{"city":"SF"}' },
                  },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
        }),
      );
    });
    gateway = await startGateway();
    seedChannel(gateway.repository, {
      name: 'Tools',
      protocol: 'openai',
      baseUrl: upstream.baseUrl,
      models: ['m'],
    });
    const response = await fetch(`${gateway.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: chatHeaders(gateway.gatewayToken),
      body: JSON.stringify({
        model: 'm',
        messages: [{ role: 'user', content: 'weather?' }],
        tools: [
          {
            type: 'function',
            function: { name: 'get_weather', parameters: { type: 'object', properties: {} } },
          },
        ],
        tool_choice: 'auto',
      }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.choices[0].finish_reason).toBe('tool_calls');
    expect(body.choices[0].message.tool_calls[0]).toMatchObject({
      id: 'call_1',
      function: { name: 'get_weather', arguments: '{"city":"SF"}' },
    });
    const upstreamBody = JSON.parse(upstream.calls[0]!.body);
    expect(upstreamBody.tools).toHaveLength(1);
    expect(upstreamBody.tool_choice).toBe('auto');
  });

  it('converts tools and tool_use through an Anthropic channel', async () => {
    upstream = await startFakeUpstream((_call, _request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(
        JSON.stringify({
          id: 'msg_tool',
          content: [{ type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: 'SF' } }],
          stop_reason: 'tool_use',
          usage: { input_tokens: 2, output_tokens: 3 },
        }),
      );
    });
    gateway = await startGateway();
    seedChannel(gateway.repository, {
      name: 'Claude Tools',
      protocol: 'anthropic',
      baseUrl: upstream.baseUrl,
      models: ['m'],
    });
    const response = await fetch(`${gateway.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: chatHeaders(gateway.gatewayToken),
      body: JSON.stringify({
        model: 'm',
        messages: [{ role: 'user', content: 'weather?' }],
        tools: [
          {
            type: 'function',
            function: { name: 'get_weather', parameters: { type: 'object', properties: {} } },
          },
        ],
      }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.choices[0].finish_reason).toBe('tool_calls');
    expect(body.choices[0].message.tool_calls[0]).toMatchObject({
      id: 'toolu_1',
      function: { name: 'get_weather', arguments: '{"city":"SF"}' },
    });
    const upstreamBody = JSON.parse(upstream.calls[0]!.body);
    expect(upstreamBody.tools).toEqual([
      { name: 'get_weather', input_schema: { type: 'object', properties: {} } },
    ]);
  });
});
