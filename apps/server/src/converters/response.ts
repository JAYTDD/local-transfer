import { UnsupportedResponseError } from '../errors.js';

export interface ChatToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ChatCompletion {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: 'assistant';
      content: string | null;
      tool_calls?: ChatToolCall[];
    };
    finish_reason: string | null;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function mapStopReason(reason: unknown): string | null {
  switch (reason) {
    case 'end_turn':
    case 'stop_sequence':
      return 'stop';
    case 'max_tokens':
      return 'length';
    case 'tool_use':
      return 'tool_calls';
    case null:
    case undefined:
      return null;
    default:
      throw new UnsupportedResponseError(`Unsupported Anthropic stop_reason "${String(reason)}"`);
  }
}

function mapUsage(value: unknown): ChatCompletion['usage'] {
  if (!isObject(value)) return undefined;
  const promptTokens = Number(value.input_tokens ?? 0);
  const completionTokens = Number(value.output_tokens ?? 0);
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
  };
}

function mapResponsesUsage(value: unknown): ChatCompletion['usage'] {
  if (!isObject(value)) return undefined;
  const promptTokens = Number(value.input_tokens ?? 0);
  const completionTokens = Number(value.output_tokens ?? 0);
  const totalTokens = Number(value.total_tokens ?? promptTokens + completionTokens);
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: totalTokens,
  };
}

export function fromOpenAiResponse(value: unknown, exposedModel: string): unknown {
  if (!isObject(value)) throw new UnsupportedResponseError('OpenAI upstream returned a non-object JSON response');
  return { ...value, model: exposedModel };
}

export function fromResponsesResponse(value: unknown, exposedModel: string): ChatCompletion {
  if (!isObject(value)) throw new UnsupportedResponseError('Responses upstream returned a non-object JSON response');
  if (value.status === 'failed') {
    const message =
      isObject(value.error) && typeof value.error.message === 'string'
        ? value.error.message
        : 'Responses upstream returned a failed response';
    throw new UnsupportedResponseError(message);
  }
  if (!Array.isArray(value.output)) {
    throw new UnsupportedResponseError('Responses upstream response is missing output items');
  }

  const textParts: string[] = [];
  const toolCalls: ChatToolCall[] = [];
  for (const [itemIndex, item] of value.output.entries()) {
    if (!isObject(item)) throw new UnsupportedResponseError(`Responses output[${itemIndex}] is not an object`);
    if (item.type === 'function_call') {
      if (typeof item.name !== 'string' || typeof item.arguments !== 'string') {
        throw new UnsupportedResponseError(`Responses output[${itemIndex}] function_call is malformed`);
      }
      toolCalls.push({
        id: typeof item.call_id === 'string' ? item.call_id : String(item.id ?? `call_${itemIndex}`),
        type: 'function',
        function: { name: item.name, arguments: item.arguments },
      });
      continue;
    }
    if (item.type !== 'message') continue;
    if (!Array.isArray(item.content)) continue;
    for (const [contentIndex, content] of item.content.entries()) {
      if (!isObject(content)) {
        throw new UnsupportedResponseError(`Responses output[${itemIndex}].content[${contentIndex}] is not an object`);
      }
      if (content.type === 'output_text' && typeof content.text === 'string') {
        textParts.push(content.text);
        continue;
      }
      if (content.type !== 'refusal') {
        throw new UnsupportedResponseError(
          `Responses content type "${String(content.type)}" is not supported`,
        );
      }
    }
  }

  const usage = mapResponsesUsage(value.usage);
  const finishReason = toolCalls.length ? 'tool_calls' : value.status === 'incomplete' ? 'length' : 'stop';
  return {
    id: `chatcmpl-${String(value.id ?? Date.now())}`,
    object: 'chat.completion',
    created: Number.isFinite(Number(value.created_at))
      ? Number(value.created_at)
      : Math.floor(Date.now() / 1000),
    model: exposedModel,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: textParts.join(''),
          ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: finishReason,
      },
    ],
    ...(usage ? { usage } : {}),
  };
}

export function fromAnthropicResponse(value: unknown, exposedModel: string): ChatCompletion {
  if (!isObject(value)) throw new UnsupportedResponseError('Anthropic upstream returned a non-object JSON response');
  if (!Array.isArray(value.content)) throw new UnsupportedResponseError('Anthropic response is missing content blocks');

  const textParts: string[] = [];
  const toolCalls: ChatToolCall[] = [];
  for (const [index, block] of value.content.entries()) {
    if (!isObject(block)) throw new UnsupportedResponseError(`Anthropic content[${index}] is not an object`);
    if (block.type === 'text' && typeof block.text === 'string') {
      textParts.push(block.text);
      continue;
    }
    if (block.type === 'tool_use') {
      if (typeof block.id !== 'string' || typeof block.name !== 'string') {
        throw new UnsupportedResponseError(`Anthropic content[${index}] tool_use is malformed`);
      }
      toolCalls.push({
        id: block.id,
        type: 'function',
        function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
      });
      continue;
    }
    throw new UnsupportedResponseError(`Anthropic content block "${String(block.type)}" is not supported`);
  }

  return {
    id: `chatcmpl-${String(value.id ?? Date.now())}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: exposedModel,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: textParts.join(''),
          ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: toolCalls.length ? 'tool_calls' : mapStopReason(value.stop_reason),
      },
    ],
    ...(mapUsage(value.usage) ? { usage: mapUsage(value.usage) } : {}),
  };
}
