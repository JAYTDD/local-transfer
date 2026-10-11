import { describe, expect, it } from 'vitest';

import {
  canonicalizeChatRequest,
  toAnthropicRequest,
  toOpenAiRequest,
  toResponsesRequest,
} from '../src/converters/request.js';
import {
  fromAnthropicResponse,
  fromOpenAiResponse,
  fromResponsesResponse,
} from '../src/converters/response.js';
import { createSseParser } from '../src/converters/sse.js';
import {
  createAnthropicStreamTransformer,
  createOpenAiStreamTransformer,
  createResponsesStreamTransformer,
} from '../src/converters/stream.js';
import { UnsupportedRequestError } from '../src/errors.js';

describe('request converters', () => {
  it('normalizes supported OpenAI fields and injects default max tokens', () => {
    const canonical = canonicalizeChatRequest({
      model: 'virtual',
      messages: [
        { role: 'system', content: 's1' },
        { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      ],
      temperature: 0.4,
      stream: true,
      stream_options: { include_usage: true },
    });
    const openai = toOpenAiRequest(canonical, 'upstream-model', 1234);
    expect(openai.model).toBe('upstream-model');
    expect(openai.max_tokens).toBe(1234);
    expect(openai.stream_options).toEqual({ include_usage: true });
  });

  it('merges system messages to Anthropic top-level before dialogue', () => {
    const canonical = canonicalizeChatRequest({
      model: 'virtual',
      messages: [
        { role: 'system', content: 'first' },
        { role: 'user', content: 'question' },
        { role: 'system', content: 'second' },
        { role: 'assistant', content: 'answer' },
      ],
      stop: 'END',
    });
    const anthropic = toAnthropicRequest(canonical, 'claude-test', 2048);
    expect(anthropic.system).toEqual([
      { type: 'text', text: 'first' },
      { type: 'text', text: 'second' },
    ]);
    expect(anthropic.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'question' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'answer' }] },
    ]);
    expect(anthropic.stop_sequences).toEqual(['END']);
    expect(anthropic.max_tokens).toBe(2048);
  });

  it('maps chat requests to Responses API input and instructions', () => {
    const canonical = canonicalizeChatRequest({
      model: 'virtual',
      messages: [
        { role: 'system', content: 'first' },
        { role: 'user', content: 'question' },
        { role: 'system', content: 'second' },
        { role: 'assistant', content: 'answer' },
      ],
    });
    const responses = toResponsesRequest(canonical, 'gpt-5', 1024);
    expect(responses.instructions).toBe('first\n\nsecond');
    expect(responses.input).toEqual([
      { role: 'user', content: 'question' },
      { role: 'assistant', content: 'answer' },
    ]);
    expect(responses.max_output_tokens).toBe(1024);
  });

  it('accepts and forwards the store flag', () => {
    const canonical = canonicalizeChatRequest({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      store: false,
    });
    expect(toOpenAiRequest(canonical, 'm', 100).store).toBe(false);
    expect(toResponsesRequest(canonical, 'm', 100).store).toBe(false);
    expect(toAnthropicRequest(canonical, 'm', 100)).not.toHaveProperty('store');
    expect(() =>
      canonicalizeChatRequest({
        model: 'm',
        messages: [{ role: 'user', content: 'hi' }],
        store: 'yes',
      }),
    ).toThrow(UnsupportedRequestError);
  });

  it('accepts common OpenAI text parameters and maps them per protocol', () => {
    const canonical = canonicalizeChatRequest({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      max_completion_tokens: 128,
      frequency_penalty: 0.2,
      presence_penalty: -0.1,
      seed: 42,
      user: 'u1',
      metadata: { trace: 't1' },
      response_format: { type: 'json_object' },
      logprobs: true,
      top_logprobs: 3,
      service_tier: 'auto',
      reasoning_effort: 'low',
      verbosity: 'low',
      logit_bias: { '123': -5 },
    });

    const openai = toOpenAiRequest(canonical, 'm', 100);
    expect(openai).toMatchObject({
      max_tokens: 128,
      frequency_penalty: 0.2,
      presence_penalty: -0.1,
      seed: 42,
      user: 'u1',
      metadata: { trace: 't1' },
      response_format: { type: 'json_object' },
      logprobs: true,
      top_logprobs: 3,
      service_tier: 'auto',
      reasoning_effort: 'low',
      verbosity: 'low',
      logit_bias: { '123': -5 },
    });

    const responses = toResponsesRequest(canonical, 'm', 100);
    expect(responses).toMatchObject({
      max_output_tokens: 128,
      metadata: { trace: 't1' },
      user: 'u1',
      service_tier: 'auto',
      top_logprobs: 3,
      text: { format: { type: 'json_object' }, verbosity: 'low' },
      reasoning: { effort: 'low' },
    });

    const anthropic = toAnthropicRequest(canonical, 'm', 100);
    expect(anthropic.max_tokens).toBe(128);
    expect(anthropic).not.toHaveProperty('metadata');
    expect(anthropic).not.toHaveProperty('reasoning_effort');
    expect(anthropic).not.toHaveProperty('response_format');
  });

  it('prefers max_completion_tokens when both token limits are present', () => {
    const canonical = canonicalizeChatRequest({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 10,
      max_completion_tokens: 20,
    });
    expect(canonical.max_tokens).toBe(20);
    expect(toOpenAiRequest(canonical, 'm', 100).max_tokens).toBe(20);
  });

  it('normalizes the developer role to system', () => {
    const canonical = canonicalizeChatRequest({
      model: 'm',
      messages: [
        { role: 'developer', content: 'rules' },
        { role: 'user', content: 'hi' },
      ],
    });
    expect(canonical.messages[0]).toEqual({ role: 'system', content: 'rules' });
    expect(toAnthropicRequest(canonical, 'm', 100).system).toEqual([{ type: 'text', text: 'rules' }]);
  });

  it('converts tool definitions and tool messages across protocols', () => {
    const canonical = canonicalizeChatRequest({
      model: 'm',
      messages: [
        { role: 'user', content: 'weather?' },
        {
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
        { role: 'tool', content: '{"temp":18}', tool_call_id: 'call_1' },
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'get_weather',
            description: 'Get weather',
            parameters: { type: 'object', properties: { city: { type: 'string' } } },
          },
        },
      ],
      tool_choice: 'auto',
      parallel_tool_calls: false,
    });

    const openai = toOpenAiRequest(canonical, 'm', 100);
    expect(openai.tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'get_weather',
          description: 'Get weather',
          parameters: { type: 'object', properties: { city: { type: 'string' } } },
        },
      },
    ]);
    expect(openai.tool_choice).toBe('auto');
    expect(openai.parallel_tool_calls).toBe(false);
    expect((openai.messages as Array<Record<string, unknown>>)[1]).toMatchObject({
      role: 'assistant',
      content: null,
    });

    const responses = toResponsesRequest(canonical, 'm', 100);
    expect(responses.tools).toEqual([
      {
        type: 'function',
        name: 'get_weather',
        description: 'Get weather',
        parameters: { type: 'object', properties: { city: { type: 'string' } } },
      },
    ]);
    expect(responses.tool_choice).toBe('auto');
    expect(responses.parallel_tool_calls).toBe(false);
    expect(responses.input).toEqual([
      { role: 'user', content: 'weather?' },
      { type: 'function_call', call_id: 'call_1', name: 'get_weather', arguments: '{"city":"SF"}' },
      { type: 'function_call_output', call_id: 'call_1', output: '{"temp":18}' },
    ]);

    const anthropic = toAnthropicRequest(canonical, 'm', 100);
    expect(anthropic.tools).toEqual([
      {
        name: 'get_weather',
        description: 'Get weather',
        input_schema: { type: 'object', properties: { city: { type: 'string' } } },
      },
    ]);
    expect(anthropic.tool_choice).toEqual({ type: 'auto' });
    expect(anthropic.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'weather?' }] },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'call_1', name: 'get_weather', input: { city: 'SF' } }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'call_1', content: '{"temp":18}' }],
      },
    ]);
  });

  it('omits Anthropic tools when tool_choice is none', () => {
    const canonical = canonicalizeChatRequest({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ type: 'function', function: { name: 'f' } }],
      tool_choice: 'none',
    });
    const anthropic = toAnthropicRequest(canonical, 'm', 100);
    expect(anthropic.tools).toBeUndefined();
    expect(anthropic.tool_choice).toBeUndefined();
  });

  it('rejects unsupported fields and multimodal content', () => {
    expect(() => canonicalizeChatRequest({ messages: [], tools: [] })).toThrow(UnsupportedRequestError);
    expect(() =>
      canonicalizeChatRequest({
        model: 'm',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [{ type: 'web_search' }],
      }),
    ).toThrow(UnsupportedRequestError);
    expect(() =>
      canonicalizeChatRequest({
        model: 'm',
        messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'x' } }] }],
      }),
    ).toThrow(UnsupportedRequestError);
  });

  it('forwards unknown chat fields to OpenAI and Responses upstreams', () => {
    const canonical = canonicalizeChatRequest({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      prompt_cache_key: 'cache-1',
      vendor_field: { enabled: true },
    });

    expect(toOpenAiRequest(canonical, 'm', 100)).toMatchObject({
      prompt_cache_key: 'cache-1',
      vendor_field: { enabled: true },
    });
    expect(toResponsesRequest(canonical, 'm', 100).prompt_cache_key).toBe('cache-1');
    expect(toAnthropicRequest(canonical, 'm', 100)).not.toHaveProperty('prompt_cache_key');
    expect(toAnthropicRequest(canonical, 'm', 100)).not.toHaveProperty('vendor_field');
  });

  it('preserves reasoning_content and other message fields for OpenAI upstreams', () => {
    const canonical = canonicalizeChatRequest({
      model: 'm',
      messages: [
        { role: 'user', content: 'hi', name: 'alice' },
        {
          role: 'assistant',
          content: null,
          reasoning_content: 'deep thought',
          tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'f', arguments: '{}' } }],
        },
      ],
    });

    expect(toOpenAiRequest(canonical, 'm', 100).messages).toEqual([
      { role: 'user', content: 'hi', name: 'alice' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'f', arguments: '{}' } }],
        reasoning_content: 'deep thought',
      },
    ]);
    expect(JSON.stringify(toAnthropicRequest(canonical, 'm', 100))).not.toContain('reasoning_content');
    expect(JSON.stringify(toAnthropicRequest(canonical, 'm', 100))).not.toContain('alice');
  });
});

describe('response converters', () => {
  it('rewrites OpenAI response model', () => {
    expect(fromOpenAiResponse({ id: 'x', model: 'upstream' }, 'virtual')).toMatchObject({
      id: 'x',
      model: 'virtual',
    });
  });

  it('maps Anthropic response and usage', () => {
    const output = fromAnthropicResponse(
      {
        id: 'msg_1',
        content: [{ type: 'text', text: 'hello' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 3, output_tokens: 4 },
      },
      'virtual',
    );
    expect(output.choices[0]?.message.content).toBe('hello');
    expect(output.choices[0]?.finish_reason).toBe('stop');
    expect(output.usage).toEqual({ prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 });
  });

  it('maps Responses output and usage', () => {
    const output = fromResponsesResponse(
      {
        id: 'resp_1',
        created_at: 123,
        status: 'completed',
        output: [
          {
            type: 'message',
            content: [{ type: 'output_text', text: 'hello' }],
          },
        ],
        usage: { input_tokens: 3, output_tokens: 4, total_tokens: 7 },
      },
      'virtual',
    );
    expect(output.id).toBe('chatcmpl-resp_1');
    expect(output.created).toBe(123);
    expect(output.choices[0]?.message.content).toBe('hello');
    expect(output.usage).toEqual({ prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 });
  });

  it('maps Anthropic tool_use responses to tool_calls', () => {
    const output = fromAnthropicResponse(
      {
        id: 'msg_2',
        content: [
          { type: 'text', text: 'let me check' },
          { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: 'SF' } },
        ],
        stop_reason: 'tool_use',
        usage: { input_tokens: 2, output_tokens: 3 },
      },
      'virtual',
    );
    expect(output.choices[0]?.finish_reason).toBe('tool_calls');
    expect(output.choices[0]?.message.tool_calls).toEqual([
      {
        id: 'toolu_1',
        type: 'function',
        function: { name: 'get_weather', arguments: '{"city":"SF"}' },
      },
    ]);
  });

  it('maps Responses function_call items to tool_calls', () => {
    const output = fromResponsesResponse(
      {
        id: 'resp_2',
        created_at: 1,
        status: 'completed',
        output: [{ type: 'function_call', call_id: 'call_9', name: 'lookup', arguments: '{"q":"x"}' }],
      },
      'virtual',
    );
    expect(output.choices[0]?.finish_reason).toBe('tool_calls');
    expect(output.choices[0]?.message.tool_calls).toEqual([
      {
        id: 'call_9',
        type: 'function',
        function: { name: 'lookup', arguments: '{"q":"x"}' },
      },
    ]);
  });
});

describe('SSE parsing and streaming conversion', () => {
  it('parses arbitrary chunk boundaries', () => {
    const parser = createSseParser();
    const events = [...'event: x\ndata: {"a":1}\n\n'].flatMap((char) => parser.push(char));
    expect(events).toEqual([{ event: 'x', data: '{"a":1}' }]);
  });

  it('rewrites OpenAI chunk model and DONE', () => {
    const transformer = createOpenAiStreamTransformer('virtual');
    const output = transformer.push(
      `data: ${JSON.stringify({ id: 'x', model: 'upstream', choices: [] })}\n\ndata: [DONE]\n\n`,
    );
    expect(output).toContain('"model":"virtual"');
    expect(output).toContain('data: [DONE]');
  });

  it('maps Anthropic events and synthesized usage', () => {
    const transformer = createAnthropicStreamTransformer('virtual', true);
    const text = [
      'event: message_start\n',
      `data: ${JSON.stringify({ type: 'message_start', message: { id: 'msg_1', usage: { input_tokens: 2 } } })}\n\n`,
      'event: content_block_delta\n',
      `data: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } })}\n\n`,
      'event: message_delta\n',
      `data: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } })}\n\n`,
      'event: message_stop\n',
      `data: ${JSON.stringify({ type: 'message_stop' })}\n\n`,
    ].join('');
    const output = transformer.push(text);
    expect(output).toContain('"role":"assistant"');
    expect(output).toContain('"content":"hi"');
    expect(output).toContain('"finish_reason":"stop"');
    expect(output).toContain('"total_tokens":5');
    expect(output).toContain('data: [DONE]');
  });

  it('maps Responses events and synthesized usage', () => {
    const transformer = createResponsesStreamTransformer('virtual', true);
    const text = [
      `event: response.created\ndata: ${JSON.stringify({
        type: 'response.created',
        response: { id: 'resp_1', created_at: 123 },
      })}\n\n`,
      `event: response.output_text.delta\ndata: ${JSON.stringify({
        type: 'response.output_text.delta',
        delta: 'hi',
      })}\n\n`,
      `event: response.completed\ndata: ${JSON.stringify({
        type: 'response.completed',
        response: {
          status: 'completed',
          usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 },
        },
      })}\n\n`,
    ].join('');
    const output = transformer.push(text);
    expect(output).toContain('"id":"chatcmpl-resp_1"');
    expect(output).toContain('"content":"hi"');
    expect(output).toContain('"total_tokens":5');
    expect(output).toContain('data: [DONE]');
  });

  it('maps Anthropic tool_use stream events to tool call deltas', () => {
    const transformer = createAnthropicStreamTransformer('virtual', false);
    const text = [
      `event: content_block_start\ndata: ${JSON.stringify({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: {} },
      })}\n\n`,
      `event: content_block_delta\ndata: ${JSON.stringify({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"city":"SF"}' },
      })}\n\n`,
      `event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n`,
      `event: message_delta\ndata: ${JSON.stringify({
        type: 'message_delta',
        delta: { stop_reason: 'tool_use' },
        usage: { output_tokens: 3 },
      })}\n\n`,
      `event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`,
    ].join('');
    const output = transformer.push(text);
    expect(output).toContain('"id":"toolu_1"');
    expect(output).toContain('"name":"get_weather"');
    expect(output).toContain('"finish_reason":"tool_calls"');
    expect(output).toContain('data: [DONE]');
  });

  it('maps Responses function_call stream events to tool call deltas', () => {
    const transformer = createResponsesStreamTransformer('virtual', false);
    const text = [
      `event: response.output_item.added\ndata: ${JSON.stringify({
        type: 'response.output_item.added',
        output_index: 1,
        item: { type: 'function_call', call_id: 'call_9', name: 'lookup', arguments: '' },
      })}\n\n`,
      `event: response.function_call_arguments.delta\ndata: ${JSON.stringify({
        type: 'response.function_call_arguments.delta',
        output_index: 1,
        delta: '{"q":"x"}',
      })}\n\n`,
      `event: response.completed\ndata: ${JSON.stringify({
        type: 'response.completed',
        response: { status: 'completed', usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } },
      })}\n\n`,
    ].join('');
    const output = transformer.push(text);
    expect(output).toContain('"id":"call_9"');
    expect(output).toContain('"name":"lookup"');
    expect(output).toContain('"finish_reason":"tool_calls"');
  });
});
