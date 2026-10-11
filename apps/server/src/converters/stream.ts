import { UnsupportedResponseError } from '../errors.js';
import { createSseParser, dataEvent } from './sse.js';

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function mapStopReason(reason: unknown): string {
  switch (reason) {
    case 'end_turn':
    case 'stop_sequence':
      return 'stop';
    case 'max_tokens':
      return 'length';
    case 'tool_use':
      return 'tool_calls';
    default:
      throw new UnsupportedResponseError(`Unsupported Anthropic stop_reason "${String(reason)}"`);
  }
}

export interface StreamTransformer {
  push(text: string): string;
  flush(): string;
}

export function createOpenAiStreamTransformer(exposedModel: string): StreamTransformer {
  const parser = createSseParser();
  let done = false;

  function transformEvents(events: ReturnType<typeof parser.push>): string {
    let output = '';
    for (const event of events) {
      if (event.data === '[DONE]') {
        if (!done) {
          output += dataEvent('[DONE]');
          done = true;
        }
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(event.data);
      } catch {
        throw new UnsupportedResponseError('OpenAI upstream sent an invalid SSE JSON event');
      }
      if (!isObject(parsed)) throw new UnsupportedResponseError('OpenAI upstream sent a non-object SSE event');
      output += dataEvent({ ...parsed, model: exposedModel });
    }
    return output;
  }

  return {
    push(text) {
      return transformEvents(parser.push(text));
    },
    flush() {
      return transformEvents(parser.flush());
    },
  };
}

export function createAnthropicStreamTransformer(
  exposedModel: string,
  includeUsage: boolean,
): StreamTransformer {
  const parser = createSseParser();
  let id = `chatcmpl-${Date.now()}`;
  let created = Math.floor(Date.now() / 1000);
  let usage: { input_tokens?: number; output_tokens?: number } = {};
  let emittedDone = false;
  const toolCallIndexes = new Map<number, number>();
  let nextToolCallIndex = 0;

  function chunk(delta: Record<string, unknown>, finishReason: string | null = null, finalUsage?: unknown): string {
    return dataEvent({
      id,
      object: 'chat.completion.chunk',
      created,
      model: exposedModel,
      choices: finishReason === 'usage'
        ? []
        : [{ index: 0, delta, finish_reason: finishReason }],
      ...(finalUsage ? { usage: finalUsage } : {}),
    });
  }

  function transformEvents(events: ReturnType<typeof parser.push>): string {
    let output = '';
    for (const event of events) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(event.data);
      } catch {
        throw new UnsupportedResponseError('Anthropic upstream sent an invalid SSE JSON event');
      }
      if (!isObject(parsed)) throw new UnsupportedResponseError('Anthropic upstream sent a non-object SSE event');
      const type = event.event ?? parsed.type;
      switch (type) {
        case 'ping':
          break;
        case 'message_start': {
          const message = isObject(parsed.message) ? parsed.message : {};
          if (typeof message.id === 'string') id = `chatcmpl-${message.id}`;
          if (typeof message.usage === 'object' && message.usage) usage = { ...usage, ...(message.usage as typeof usage) };
          output += chunk({ role: 'assistant', content: '' });
          break;
        }
        case 'content_block_start': {
          const block = isObject(parsed.content_block) ? parsed.content_block : null;
          if (block?.type === 'text') {
            if (typeof block.text === 'string' && block.text) output += chunk({ content: block.text });
            break;
          }
          if (block?.type === 'tool_use') {
            if (typeof block.id !== 'string' || typeof block.name !== 'string') {
              throw new UnsupportedResponseError('Anthropic tool_use block is malformed');
            }
            const blockIndex = Number(parsed.index ?? 0);
            const toolIndex = nextToolCallIndex++;
            toolCallIndexes.set(blockIndex, toolIndex);
            output += chunk({
              tool_calls: [
                {
                  index: toolIndex,
                  id: block.id,
                  type: 'function',
                  function: { name: block.name, arguments: '' },
                },
              ],
            });
            break;
          }
          throw new UnsupportedResponseError(`Anthropic content block "${String(block?.type)}" is not supported`);
        }
        case 'content_block_delta': {
          const delta = isObject(parsed.delta) ? parsed.delta : null;
          if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
            output += chunk({ content: delta.text });
            break;
          }
          if (delta?.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
            const blockIndex = Number(parsed.index ?? 0);
            const toolIndex = toolCallIndexes.get(blockIndex) ?? 0;
            output += chunk({
              tool_calls: [{ index: toolIndex, function: { arguments: delta.partial_json } }],
            });
          }
          break;
        }
        case 'content_block_stop':
          break;
        case 'message_delta': {
          if (isObject(parsed.usage)) usage = { ...usage, ...(parsed.usage as typeof usage) };
          const reason = isObject(parsed.delta) ? parsed.delta.stop_reason : undefined;
          output += chunk({}, mapStopReason(reason));
          break;
        }
        case 'message_stop': {
          if (includeUsage) {
            const promptTokens = Number(usage.input_tokens ?? 0);
            const completionTokens = Number(usage.output_tokens ?? 0);
            output += chunk({}, 'usage', {
              prompt_tokens: promptTokens,
              completion_tokens: completionTokens,
              total_tokens: promptTokens + completionTokens,
            });
          }
          output += dataEvent('[DONE]');
          emittedDone = true;
          break;
        }
        case 'error':
          throw new UnsupportedResponseError(
            isObject(parsed.error) && typeof parsed.error.message === 'string'
              ? parsed.error.message
              : 'Anthropic stream returned an error event',
          );
        default:
          throw new UnsupportedResponseError(`Unsupported Anthropic SSE event "${String(type)}"`);
      }
    }
    return output;
  }

  return {
    push(text) {
      return transformEvents(parser.push(text));
    },
    flush() {
      const output = transformEvents(parser.flush());
      if (!emittedDone) {
        emittedDone = true;
        return `${output}${dataEvent('[DONE]')}`;
      }
      return output;
    },
  };
}

export function createResponsesStreamTransformer(
  exposedModel: string,
  includeUsage: boolean,
): StreamTransformer {
  const parser = createSseParser();
  let id = `chatcmpl-${Date.now()}`;
  let created = Math.floor(Date.now() / 1000);
  let usage: { input_tokens?: number; output_tokens?: number; total_tokens?: number } = {};
  let emittedDone = false;
  const toolCallIndexes = new Map<number, number>();
  let nextToolCallIndex = 0;
  let sawToolCall = false;

  function chunk(delta: Record<string, unknown>, finishReason: string | null = null, finalUsage?: unknown): string {
    return dataEvent({
      id,
      object: 'chat.completion.chunk',
      created,
      model: exposedModel,
      choices: finalUsage
        ? []
        : [{ index: 0, delta, finish_reason: finishReason }],
      ...(finalUsage ? { usage: finalUsage } : {}),
    });
  }

  function transformEvents(events: ReturnType<typeof parser.push>): string {
    let output = '';
    for (const event of events) {
      if (event.data === '[DONE]') {
        if (!emittedDone) {
          output += dataEvent('[DONE]');
          emittedDone = true;
        }
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(event.data);
      } catch {
        throw new UnsupportedResponseError('Responses upstream sent an invalid SSE JSON event');
      }
      if (!isObject(parsed)) throw new UnsupportedResponseError('Responses upstream sent a non-object SSE event');
      const type = event.event ?? parsed.type;
      switch (type) {
        case 'response.created': {
          const response = isObject(parsed.response) ? parsed.response : {};
          if (typeof response.id === 'string') id = `chatcmpl-${response.id}`;
          if (Number.isFinite(Number(response.created_at))) created = Number(response.created_at);
          if (isObject(response.usage)) usage = { ...usage, ...(response.usage as typeof usage) };
          output += chunk({ role: 'assistant', content: '' });
          break;
        }
        case 'response.output_text.delta':
          if (typeof parsed.delta === 'string') output += chunk({ content: parsed.delta });
          break;
        case 'response.output_item.added': {
          const item = isObject(parsed.item) ? parsed.item : null;
          if (item?.type !== 'function_call') break;
          const outputIndex = Number(parsed.output_index ?? 0);
          const toolIndex = nextToolCallIndex++;
          toolCallIndexes.set(outputIndex, toolIndex);
          sawToolCall = true;
          output += chunk({
            tool_calls: [
              {
                index: toolIndex,
                id: typeof item.call_id === 'string' ? item.call_id : String(item.id ?? `call_${toolIndex}`),
                type: 'function',
                function: {
                  name: typeof item.name === 'string' ? item.name : '',
                  arguments: typeof item.arguments === 'string' ? item.arguments : '',
                },
              },
            ],
          });
          break;
        }
        case 'response.function_call_arguments.delta': {
          if (typeof parsed.delta !== 'string') break;
          const outputIndex = Number(parsed.output_index ?? 0);
          const toolIndex = toolCallIndexes.get(outputIndex) ?? 0;
          output += chunk({ tool_calls: [{ index: toolIndex, function: { arguments: parsed.delta } }] });
          break;
        }
        case 'response.output_item.done': {
          const item = isObject(parsed.item) ? parsed.item : null;
          if (item?.type !== 'function_call') break;
          const outputIndex = Number(parsed.output_index ?? 0);
          if (toolCallIndexes.has(outputIndex)) break;
          const toolIndex = nextToolCallIndex++;
          toolCallIndexes.set(outputIndex, toolIndex);
          sawToolCall = true;
          output += chunk({
            tool_calls: [
              {
                index: toolIndex,
                id: typeof item.call_id === 'string' ? item.call_id : String(item.id ?? `call_${toolIndex}`),
                type: 'function',
                function: {
                  name: typeof item.name === 'string' ? item.name : '',
                  arguments: typeof item.arguments === 'string' ? item.arguments : '',
                },
              },
            ],
          });
          break;
        }
        case 'response.completed': {
          const response = isObject(parsed.response) ? parsed.response : {};
          if (isObject(response.usage)) usage = { ...usage, ...(response.usage as typeof usage) };
          const finishReason = sawToolCall ? 'tool_calls' : response.status === 'incomplete' ? 'length' : 'stop';
          output += chunk({}, finishReason);
          if (includeUsage) {
            const promptTokens = Number(usage.input_tokens ?? 0);
            const completionTokens = Number(usage.output_tokens ?? 0);
            output += chunk({}, null, {
              prompt_tokens: promptTokens,
              completion_tokens: completionTokens,
              total_tokens: Number(usage.total_tokens ?? promptTokens + completionTokens),
            });
          }
          output += dataEvent('[DONE]');
          emittedDone = true;
          break;
        }
        case 'response.failed': {
          const response = isObject(parsed.response) ? parsed.response : {};
          const message =
            isObject(response.error) && typeof response.error.message === 'string'
              ? response.error.message
              : 'Responses upstream returned a failed response';
          throw new UnsupportedResponseError(message);
        }
        case 'error':
          throw new UnsupportedResponseError(
            isObject(parsed.error) && typeof parsed.error.message === 'string'
              ? parsed.error.message
              : 'Responses upstream returned an error event',
          );
        default:
          break;
      }
    }
    return output;
  }

  return {
    push(text) {
      return transformEvents(parser.push(text));
    },
    flush() {
      const output = transformEvents(parser.flush());
      if (!emittedDone) {
        emittedDone = true;
        return `${output}${dataEvent('[DONE]')}`;
      }
      return output;
    },
  };
}
