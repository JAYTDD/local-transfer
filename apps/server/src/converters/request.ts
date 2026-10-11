import { UnsupportedRequestError } from '../errors.js';

type JsonObject = Record<string, unknown>;

export interface CanonicalToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface CanonicalTool {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
    strict?: boolean;
  };
}

export type CanonicalToolChoice =
  | 'none'
  | 'auto'
  | 'required'
  | { type: 'function'; function: { name: string } };

type MessagePassthrough = { passthrough?: Record<string, unknown> };

export type CanonicalMessage =
  | ({ role: 'system'; content: string } & MessagePassthrough)
  | ({ role: 'user'; content: string } & MessagePassthrough)
  | ({ role: 'assistant'; content: string | null; tool_calls?: CanonicalToolCall[] } & MessagePassthrough)
  | ({ role: 'tool'; content: string; tool_call_id: string } & MessagePassthrough);

export interface CanonicalChatRequest {
  model: string;
  messages: CanonicalMessage[];
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  stop?: string | string[];
  stream: boolean;
  includeUsage: boolean;
  store?: boolean;
  frequencyPenalty?: number;
  presencePenalty?: number;
  seed?: number;
  user?: string;
  metadata?: Record<string, unknown>;
  responseFormat?: Record<string, unknown>;
  logprobs?: boolean;
  topLogprobs?: number;
  serviceTier?: string;
  reasoningEffort?: string;
  verbosity?: string;
  logitBias?: Record<string, unknown>;
  tools?: CanonicalTool[];
  toolChoice?: CanonicalToolChoice;
  parallelToolCalls?: boolean;
  passthrough?: Record<string, unknown>;
}

const SUPPORTED_KEYS = new Set([
  'model',
  'messages',
  'temperature',
  'top_p',
  'max_tokens',
  'max_completion_tokens',
  'stop',
  'stream',
  'stream_options',
  'store',
  'frequency_penalty',
  'presence_penalty',
  'seed',
  'user',
  'metadata',
  'response_format',
  'logprobs',
  'top_logprobs',
  'service_tier',
  'reasoning_effort',
  'verbosity',
  'logit_bias',
  'tools',
  'tool_choice',
  'parallel_tool_calls',
  'n',
]);

const BASIC_MESSAGE_KEYS = new Set(['role', 'content']);
const ASSISTANT_MESSAGE_KEYS = new Set(['role', 'content', 'tool_calls']);
const TOOL_MESSAGE_KEYS = new Set(['role', 'content', 'tool_call_id']);

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function collectPassthrough(source: JsonObject, knownKeys: Set<string>): Record<string, unknown> {
  const passthrough: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (!knownKeys.has(key)) passthrough[key] = value;
  }
  return passthrough;
}

function textFromContent(content: unknown, label: string): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) throw new UnsupportedRequestError(label, `Message ${label} must be a string or text block array`);
  const parts: string[] = [];
  for (const [index, part] of content.entries()) {
    if (!isObject(part) || part.type !== 'text' || typeof part.text !== 'string') {
      throw new UnsupportedRequestError(`${label}[${index}]`, 'Only text message content is supported');
    }
    parts.push(part.text);
  }
  return parts.join('');
}

function validateNumberField(body: JsonObject, key: string): number | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new UnsupportedRequestError(key);
  return value;
}

function validateIntegerField(body: JsonObject, key: string): number | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value)) throw new UnsupportedRequestError(key);
  return value;
}

function validateBooleanField(body: JsonObject, key: string): boolean | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw new UnsupportedRequestError(key);
  return value;
}

function validateStringField(body: JsonObject, key: string): string | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new UnsupportedRequestError(key);
  return value;
}

function validateObjectField(body: JsonObject, key: string): Record<string, unknown> | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (!isObject(value)) throw new UnsupportedRequestError(key);
  return value;
}

function validateStop(value: unknown): string | string[] | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) return value;
  throw new UnsupportedRequestError('stop');
}

function parseToolCalls(value: unknown, messageIndex: number): CanonicalToolCall[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new UnsupportedRequestError(`messages[${messageIndex}].tool_calls`);
  return value.map((raw, callIndex) => {
    const label = `messages[${messageIndex}].tool_calls[${callIndex}]`;
    if (!isObject(raw)) throw new UnsupportedRequestError(label);
    if (raw.type !== 'function') {
      throw new UnsupportedRequestError(`${label}.type`, 'Only function tool calls are supported');
    }
    if (typeof raw.id !== 'string' || !raw.id.trim()) throw new UnsupportedRequestError(`${label}.id`);
    if (!isObject(raw.function)) throw new UnsupportedRequestError(`${label}.function`);
    const fn = raw.function;
    if (typeof fn.name !== 'string' || !fn.name.trim()) throw new UnsupportedRequestError(`${label}.function.name`);
    if (typeof fn.arguments !== 'string') throw new UnsupportedRequestError(`${label}.function.arguments`);
    return {
      id: raw.id,
      type: 'function',
      function: { name: fn.name, arguments: fn.arguments },
    };
  });
}

function parseTools(value: unknown): CanonicalTool[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new UnsupportedRequestError('tools');
  return value.map((raw, index) => {
    const label = `tools[${index}]`;
    if (!isObject(raw)) throw new UnsupportedRequestError(label);
    if (raw.type !== 'function') {
      throw new UnsupportedRequestError(`${label}.type`, 'Only function tools are supported');
    }
    if (!isObject(raw.function)) throw new UnsupportedRequestError(`${label}.function`);
    const fn = raw.function;
    if (typeof fn.name !== 'string' || !fn.name.trim()) throw new UnsupportedRequestError(`${label}.function.name`);
    if (fn.description !== undefined && typeof fn.description !== 'string') {
      throw new UnsupportedRequestError(`${label}.function.description`);
    }
    if (fn.parameters !== undefined && !isObject(fn.parameters)) {
      throw new UnsupportedRequestError(`${label}.function.parameters`);
    }
    if (fn.strict !== undefined && typeof fn.strict !== 'boolean') {
      throw new UnsupportedRequestError(`${label}.function.strict`);
    }
    return {
      type: 'function',
      function: {
        name: fn.name,
        ...(fn.description !== undefined ? { description: fn.description } : {}),
        ...(fn.parameters !== undefined ? { parameters: fn.parameters } : {}),
        ...(fn.strict !== undefined ? { strict: fn.strict } : {}),
      },
    };
  });
}

function parseToolChoice(value: unknown): CanonicalToolChoice | undefined {
  if (value === undefined) return undefined;
  if (value === 'none' || value === 'auto' || value === 'required') return value;
  if (
    isObject(value) &&
    value.type === 'function' &&
    isObject(value.function) &&
    typeof value.function.name === 'string' &&
    value.function.name.trim()
  ) {
    return { type: 'function', function: { name: value.function.name } };
  }
  throw new UnsupportedRequestError('tool_choice');
}

export function canonicalizeChatRequest(body: unknown): CanonicalChatRequest {
  if (!isObject(body)) throw new UnsupportedRequestError('body', 'Request body must be a JSON object');
  const passthrough = collectPassthrough(body, SUPPORTED_KEYS);

  if (typeof body.model !== 'string' || !body.model.trim()) throw new UnsupportedRequestError('model');
  if (!Array.isArray(body.messages) || body.messages.length === 0) throw new UnsupportedRequestError('messages');
  if (body.n !== undefined && body.n !== 1) throw new UnsupportedRequestError('n');
  if (body.stream !== undefined && typeof body.stream !== 'boolean') throw new UnsupportedRequestError('stream');

  let includeUsage = false;
  if (body.stream_options !== undefined) {
    if (!isObject(body.stream_options)) throw new UnsupportedRequestError('stream_options');
    for (const key of Object.keys(body.stream_options)) {
      if (key !== 'include_usage') throw new UnsupportedRequestError(`stream_options.${key}`);
    }
    if (body.stream_options.include_usage !== undefined) {
      if (typeof body.stream_options.include_usage !== 'boolean') {
        throw new UnsupportedRequestError('stream_options.include_usage');
      }
      includeUsage = body.stream_options.include_usage;
    }
  }

  const messages: CanonicalChatRequest['messages'] = [];
  body.messages.forEach((raw, index) => {
    if (!isObject(raw)) throw new UnsupportedRequestError(`messages[${index}]`);
    const role = raw.role;
    if (role === 'system' || role === 'developer' || role === 'user') {
      const messagePassthrough = collectPassthrough(raw, BASIC_MESSAGE_KEYS);
      messages.push({
        role: role === 'user' ? 'user' : 'system',
        content: textFromContent(raw.content, `messages[${index}].content`),
        ...(Object.keys(messagePassthrough).length ? { passthrough: messagePassthrough } : {}),
      });
      return;
    }
    if (role === 'assistant') {
      const messagePassthrough = collectPassthrough(raw, ASSISTANT_MESSAGE_KEYS);
      const toolCalls = parseToolCalls(raw.tool_calls, index);
      const content =
        raw.content === undefined || raw.content === null
          ? null
          : textFromContent(raw.content, `messages[${index}].content`);
      if (content === null && !toolCalls?.length) {
        throw new UnsupportedRequestError(
          `messages[${index}].content`,
          'Assistant message requires content or tool_calls',
        );
      }
      messages.push({
        role: 'assistant',
        content,
        ...(toolCalls?.length ? { tool_calls: toolCalls } : {}),
        ...(Object.keys(messagePassthrough).length ? { passthrough: messagePassthrough } : {}),
      });
      return;
    }
    if (role === 'tool') {
      const messagePassthrough = collectPassthrough(raw, TOOL_MESSAGE_KEYS);
      if (typeof raw.tool_call_id !== 'string' || !raw.tool_call_id.trim()) {
        throw new UnsupportedRequestError(`messages[${index}].tool_call_id`);
      }
      messages.push({
        role: 'tool',
        content: textFromContent(raw.content, `messages[${index}].content`),
        tool_call_id: raw.tool_call_id,
        ...(Object.keys(messagePassthrough).length ? { passthrough: messagePassthrough } : {}),
      });
      return;
    }
    {
      throw new UnsupportedRequestError(
        `messages[${index}].role`,
        'Only system, developer, user, assistant, and tool roles are supported',
      );
    }
  });

  const maxTokens = validateNumberField(body, 'max_tokens');
  const maxCompletionTokens = validateNumberField(body, 'max_completion_tokens');
  const effectiveMaxTokens = maxCompletionTokens ?? maxTokens;
  const tools = parseTools(body.tools);
  const toolChoice = parseToolChoice(body.tool_choice);
  const parallelToolCalls = validateBooleanField(body, 'parallel_tool_calls');

  return {
    model: body.model,
    messages,
    ...(validateNumberField(body, 'temperature') !== undefined ? { temperature: body.temperature as number } : {}),
    ...(validateNumberField(body, 'top_p') !== undefined ? { top_p: body.top_p as number } : {}),
    ...(effectiveMaxTokens !== undefined ? { max_tokens: effectiveMaxTokens } : {}),
    ...(validateStop(body.stop) !== undefined ? { stop: body.stop as string | string[] } : {}),
    stream: body.stream === true,
    includeUsage,
    ...(validateBooleanField(body, 'store') !== undefined ? { store: body.store as boolean } : {}),
    ...(validateNumberField(body, 'frequency_penalty') !== undefined
      ? { frequencyPenalty: body.frequency_penalty as number }
      : {}),
    ...(validateNumberField(body, 'presence_penalty') !== undefined
      ? { presencePenalty: body.presence_penalty as number }
      : {}),
    ...(validateIntegerField(body, 'seed') !== undefined ? { seed: body.seed as number } : {}),
    ...(validateStringField(body, 'user') !== undefined ? { user: body.user as string } : {}),
    ...(validateObjectField(body, 'metadata') !== undefined
      ? { metadata: body.metadata as Record<string, unknown> }
      : {}),
    ...(validateObjectField(body, 'response_format') !== undefined
      ? { responseFormat: body.response_format as Record<string, unknown> }
      : {}),
    ...(validateBooleanField(body, 'logprobs') !== undefined ? { logprobs: body.logprobs as boolean } : {}),
    ...(validateIntegerField(body, 'top_logprobs') !== undefined ? { topLogprobs: body.top_logprobs as number } : {}),
    ...(validateStringField(body, 'service_tier') !== undefined ? { serviceTier: body.service_tier as string } : {}),
    ...(validateStringField(body, 'reasoning_effort') !== undefined
      ? { reasoningEffort: body.reasoning_effort as string }
      : {}),
    ...(validateStringField(body, 'verbosity') !== undefined ? { verbosity: body.verbosity as string } : {}),
    ...(validateObjectField(body, 'logit_bias') !== undefined
      ? { logitBias: body.logit_bias as Record<string, unknown> }
      : {}),
    ...(tools !== undefined ? { tools } : {}),
    ...(toolChoice !== undefined ? { toolChoice } : {}),
    ...(parallelToolCalls !== undefined ? { parallelToolCalls } : {}),
    ...(Object.keys(passthrough).length ? { passthrough } : {}),
  };
}

export function toOpenAiRequest(request: CanonicalChatRequest, upstreamModel: string, defaultMaxTokens: number): JsonObject {
  return {
    ...request.passthrough,
    model: upstreamModel,
    messages: request.messages.map(({ passthrough, ...message }) => ({
      ...passthrough,
      ...message,
    })),
    ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    ...(request.top_p !== undefined ? { top_p: request.top_p } : {}),
    max_tokens: request.max_tokens ?? defaultMaxTokens,
    ...(request.stop !== undefined ? { stop: request.stop } : {}),
    ...(request.store !== undefined ? { store: request.store } : {}),
    ...(request.frequencyPenalty !== undefined ? { frequency_penalty: request.frequencyPenalty } : {}),
    ...(request.presencePenalty !== undefined ? { presence_penalty: request.presencePenalty } : {}),
    ...(request.seed !== undefined ? { seed: request.seed } : {}),
    ...(request.user !== undefined ? { user: request.user } : {}),
    ...(request.metadata !== undefined ? { metadata: request.metadata } : {}),
    ...(request.responseFormat !== undefined ? { response_format: request.responseFormat } : {}),
    ...(request.logprobs !== undefined ? { logprobs: request.logprobs } : {}),
    ...(request.topLogprobs !== undefined ? { top_logprobs: request.topLogprobs } : {}),
    ...(request.serviceTier !== undefined ? { service_tier: request.serviceTier } : {}),
    ...(request.reasoningEffort !== undefined ? { reasoning_effort: request.reasoningEffort } : {}),
    ...(request.verbosity !== undefined ? { verbosity: request.verbosity } : {}),
    ...(request.logitBias !== undefined ? { logit_bias: request.logitBias } : {}),
    ...(request.tools !== undefined ? { tools: request.tools } : {}),
    ...(request.toolChoice !== undefined ? { tool_choice: request.toolChoice } : {}),
    ...(request.parallelToolCalls !== undefined ? { parallel_tool_calls: request.parallelToolCalls } : {}),
    ...(request.stream
      ? {
          stream: true,
          ...(request.includeUsage ? { stream_options: { include_usage: true } } : {}),
        }
      : {}),
  };
}

function toResponsesTextFormat(
  responseFormat: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!responseFormat) return undefined;
  const type = responseFormat.type;
  if (type === 'json_object' || type === 'text') return { type };
  if (type === 'json_schema' && isObject(responseFormat.json_schema)) {
    const jsonSchema = responseFormat.json_schema;
    return {
      type: 'json_schema',
      ...(typeof jsonSchema.name === 'string' ? { name: jsonSchema.name } : {}),
      ...(jsonSchema.schema !== undefined ? { schema: jsonSchema.schema } : {}),
      ...(typeof jsonSchema.strict === 'boolean' ? { strict: jsonSchema.strict } : {}),
    };
  }
  return undefined;
}

export function toResponsesRequest(
  request: CanonicalChatRequest,
  upstreamModel: string,
  defaultMaxTokens: number,
): JsonObject {
  if (request.stop !== undefined) {
    throw new UnsupportedRequestError('stop', 'Request field "stop" is not supported for Responses API channels');
  }
  const systemMessages = request.messages.filter(
    (message): message is { role: 'system'; content: string } => message.role === 'system',
  );
  const input: Array<Record<string, unknown>> = [];
  for (const message of request.messages) {
    if (message.role === 'system') continue;
    if (message.role === 'user') {
      input.push({ role: 'user', content: message.content });
      continue;
    }
    if (message.role === 'assistant') {
      if (message.content) input.push({ role: 'assistant', content: message.content });
      for (const call of message.tool_calls ?? []) {
        input.push({
          type: 'function_call',
          call_id: call.id,
          name: call.function.name,
          arguments: call.function.arguments,
        });
      }
      continue;
    }
    input.push({
      type: 'function_call_output',
      call_id: message.tool_call_id,
      output: message.content,
    });
  }
  const tools = request.tools?.map((tool) => ({
    type: 'function',
    name: tool.function.name,
    ...(tool.function.description !== undefined ? { description: tool.function.description } : {}),
    ...(tool.function.parameters !== undefined ? { parameters: tool.function.parameters } : {}),
    ...(tool.function.strict !== undefined ? { strict: tool.function.strict } : {}),
  }));
  const toolChoice =
    request.toolChoice === undefined
      ? undefined
      : typeof request.toolChoice === 'string'
        ? request.toolChoice
        : { type: 'function', name: request.toolChoice.function.name };
  const text: Record<string, unknown> = {};
  const textFormat = toResponsesTextFormat(request.responseFormat);
  if (textFormat) text.format = textFormat;
  if (request.verbosity !== undefined) text.verbosity = request.verbosity;

  return {
    ...request.passthrough,
    model: upstreamModel,
    ...(systemMessages.length
      ? { instructions: systemMessages.map((message) => message.content).join('\n\n') }
      : {}),
    input,
    max_output_tokens: request.max_tokens ?? defaultMaxTokens,
    ...(request.store !== undefined ? { store: request.store } : {}),
    ...(request.metadata !== undefined ? { metadata: request.metadata } : {}),
    ...(request.user !== undefined ? { user: request.user } : {}),
    ...(request.serviceTier !== undefined ? { service_tier: request.serviceTier } : {}),
    ...(request.topLogprobs !== undefined ? { top_logprobs: request.topLogprobs } : {}),
    ...(request.reasoningEffort !== undefined ? { reasoning: { effort: request.reasoningEffort } } : {}),
    ...(tools?.length ? { tools } : {}),
    ...(toolChoice !== undefined ? { tool_choice: toolChoice } : {}),
    ...(request.parallelToolCalls !== undefined ? { parallel_tool_calls: request.parallelToolCalls } : {}),
    ...(Object.keys(text).length ? { text } : {}),
    ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    ...(request.top_p !== undefined ? { top_p: request.top_p } : {}),
    ...(request.stream ? { stream: true } : {}),
  };
}

export function toAnthropicRequest(
  request: CanonicalChatRequest,
  upstreamModel: string,
  defaultMaxTokens: number,
): JsonObject {
  const systemMessages = request.messages.filter(
    (message): message is { role: 'system'; content: string } => message.role === 'system',
  );
  const merged: Array<{ role: 'user' | 'assistant'; content: Array<Record<string, unknown>> }> = [];
  const append = (role: 'user' | 'assistant', block: Record<string, unknown>): void => {
    const last = merged.at(-1);
    if (last?.role === role) {
      last.content.push(block);
    } else {
      merged.push({ role, content: [block] });
    }
  };

  for (const message of request.messages) {
    if (message.role === 'system') continue;
    if (message.role === 'user') {
      append('user', { type: 'text', text: message.content });
      continue;
    }
    if (message.role === 'assistant') {
      if (message.content) append('assistant', { type: 'text', text: message.content });
      for (const call of message.tool_calls ?? []) {
        append('assistant', {
          type: 'tool_use',
          id: call.id,
          name: call.function.name,
          input: parseToolArguments(call.function.arguments),
        });
      }
      continue;
    }
    append('user', {
      type: 'tool_result',
      tool_use_id: message.tool_call_id,
      content: message.content,
    });
  }

  const tools =
    request.toolChoice === 'none'
      ? undefined
      : request.tools?.map((tool) => ({
          name: tool.function.name,
          ...(tool.function.description !== undefined ? { description: tool.function.description } : {}),
          input_schema: tool.function.parameters ?? { type: 'object', properties: {} },
        }));
  const toolChoice =
    request.toolChoice === undefined || request.toolChoice === 'none'
      ? undefined
      : request.toolChoice === 'auto'
        ? { type: 'auto' }
        : request.toolChoice === 'required'
          ? { type: 'any' }
          : { type: 'tool', name: request.toolChoice.function.name };

  return {
    model: upstreamModel,
    max_tokens: request.max_tokens ?? defaultMaxTokens,
    ...(systemMessages.length
      ? { system: systemMessages.map((message) => ({ type: 'text', text: message.content })) }
      : {}),
    messages: merged,
    ...(tools?.length ? { tools } : {}),
    ...(toolChoice !== undefined ? { tool_choice: toolChoice } : {}),
    ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    ...(request.top_p !== undefined ? { top_p: request.top_p } : {}),
    ...(request.stop !== undefined
      ? { stop_sequences: Array.isArray(request.stop) ? request.stop : [request.stop] }
      : {}),
    ...(request.stream ? { stream: true } : {}),
  };
}

function parseToolArguments(argumentsText: string): unknown {
  if (!argumentsText.trim()) return {};
  try {
    return JSON.parse(argumentsText);
  } catch {
    return {};
  }
}
