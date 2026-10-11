import type { FastifyReply, FastifyRequest } from 'fastify';

import {
  canonicalizeChatRequest,
  toAnthropicRequest,
  toOpenAiRequest,
  toResponsesRequest,
  type CanonicalChatRequest,
} from './converters/request.js';
import { fromAnthropicResponse, fromOpenAiResponse, fromResponsesResponse } from './converters/response.js';
import { dataEvent } from './converters/sse.js';
import {
  createAnthropicStreamTransformer,
  createOpenAiStreamTransformer,
  createResponsesStreamTransformer,
  type StreamTransformer,
} from './converters/stream.js';
import { Repository } from './db.js';
import {
  sendOpenAiError,
  UnsupportedRequestError,
  UnsupportedResponseError,
} from './errors.js';
import type { ChannelRecord } from './types.js';
import { joinUpstreamUrl, upstreamHeaders } from './upstream.js';

function safeErrorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

/** 渠道独立端点：客户端可带或不带该渠道前缀，统一剥离后使用真实模型名 */
function stripChannelPrefix(model: string, channelName: string): string {
  const prefix = `${channelName}/`;
  return model.startsWith(prefix) ? model.slice(prefix.length) : model;
}

/** 全局端点：按渠道名解析 `渠道名/模型名`；渠道名互为前缀时取最长匹配 */
function resolveChannelPrefix(
  model: string,
  channels: ChannelRecord[],
): { channel: ChannelRecord; upstreamModel: string } | null {
  let best: { channel: ChannelRecord; upstreamModel: string } | null = null;
  let bestPrefixLength = 0;
  for (const channel of channels) {
    const prefix = `${channel.name}/`;
    if (!model.startsWith(prefix)) continue;
    const upstreamModel = model.slice(prefix.length);
    if (!upstreamModel || prefix.length <= bestPrefixLength) continue;
    best = { channel, upstreamModel };
    bestPrefixLength = prefix.length;
  }
  return best;
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

const BLOCKED_FORWARD_HEADERS = new Set([
  'authorization',
  'x-api-key',
  'host',
  'content-length',
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'proxy-authorization',
  'proxy-authenticate',
  'te',
  'trailer',
  'content-type',
]);

function forwardedClientHeaders(headers: FastifyRequest['headers']): Record<string, string> {
  const forwarded: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || BLOCKED_FORWARD_HEADERS.has(name.toLowerCase())) continue;
    forwarded[name] = Array.isArray(value) ? value.join(', ') : value;
  }
  return forwarded;
}

async function readBodyWithTimeout(
  response: Response,
  controller: AbortController,
  timeoutMs: number,
): Promise<string> {
  const timeout = setTimeout(() => controller.abort(new Error('response_timeout')), timeoutMs);
  try {
    return await response.text();
  } finally {
    clearTimeout(timeout);
  }
}

export interface ChatProxyOptions {
  repository: Repository;
  fetchImpl?: typeof fetch;
  channelId?: string;
}

export async function handleChatCompletions(
  request: FastifyRequest,
  reply: FastifyReply,
  options: ChatProxyOptions,
): Promise<void> {
  const repository = options.repository;
  const fetchImpl = options.fetchImpl ?? fetch;
  const startedAt = Date.now();

  let body: CanonicalChatRequest;
  try {
    body = canonicalizeChatRequest(request.body);
  } catch (error) {
    if (error instanceof UnsupportedRequestError) {
      sendOpenAiError(reply, 400, error.message, error.code, 'invalid_request_error', error.param);
      return;
    }
    throw error;
  }

  let channel: ChannelRecord;
  let upstreamModel = body.model;
  if (options.channelId) {
    const selected = repository.getChannel(options.channelId);
    if (!selected) {
      sendOpenAiError(
        reply,
        404,
        `Channel "${options.channelId}" was not found`,
        'channel_not_found',
        'invalid_request_error',
        'channelId',
      );
      return;
    }
    upstreamModel = stripChannelPrefix(body.model, selected.name);
    if (!upstreamModel || !selected.models.includes(upstreamModel)) {
      sendOpenAiError(
        reply,
        404,
        `Model "${body.model}" is not configured on channel "${selected.name}"`,
        'model_not_found',
        'invalid_request_error',
        'model',
      );
      return;
    }
    if (!selected.enabled) {
      sendOpenAiError(reply, 503, `Channel "${selected.name}" is disabled`, 'channel_unavailable', 'server_error');
      repository.insertLog({
        createdAt: Math.floor(Date.now() / 1000),
        virtualModel: body.model,
        channelId: selected.id,
        channelName: selected.name,
        protocol: selected.protocol,
        upstreamModel,
        stream: body.stream,
        status: 'error',
        httpStatus: 503,
        durationMs: Date.now() - startedAt,
        errorSummary: 'channel disabled',
      });
      return;
    }
    channel = selected;
  } else {
    const prefixed = resolveChannelPrefix(body.model, repository.listChannels());
    if (prefixed) {
      channel = prefixed.channel;
      upstreamModel = prefixed.upstreamModel;
      if (!channel.models.includes(upstreamModel)) {
        sendOpenAiError(
          reply,
          404,
          `Model "${body.model}" is not configured on channel "${channel.name}"`,
          'model_not_found',
          'invalid_request_error',
          'model',
        );
        return;
      }
      if (!channel.enabled) {
        sendOpenAiError(reply, 503, `Channel "${channel.name}" is disabled`, 'channel_unavailable', 'server_error');
        repository.insertLog({
          createdAt: Math.floor(Date.now() / 1000),
          virtualModel: body.model,
          channelId: channel.id,
          channelName: channel.name,
          protocol: channel.protocol,
          upstreamModel,
          stream: body.stream,
          status: 'error',
          httpStatus: 503,
          durationMs: Date.now() - startedAt,
          errorSummary: 'channel disabled',
        });
        return;
      }
    } else {
      const configured = repository.listChannelsByModel(body.model);
      if (configured.length === 0) {
        sendOpenAiError(reply, 404, `Model "${body.model}" was not found`, 'model_not_found', 'invalid_request_error', 'model');
        return;
      }
      if (configured.length > 1) {
        sendOpenAiError(
          reply,
          400,
          `Model "${body.model}" is configured on multiple channels; use a channel-specific endpoint`,
          'model_ambiguous',
          'invalid_request_error',
          'model',
        );
        return;
      }
      channel = configured[0]!;
      if (!channel.enabled) {
        sendOpenAiError(reply, 503, `Model "${body.model}" has no enabled channel`, 'model_unavailable', 'server_error');
        repository.insertLog({
          createdAt: Math.floor(Date.now() / 1000),
          virtualModel: body.model,
          channelId: channel.id,
          channelName: channel.name,
          protocol: channel.protocol,
          upstreamModel,
          stream: body.stream,
          status: 'error',
          httpStatus: 503,
          durationMs: Date.now() - startedAt,
          errorSummary: 'no enabled channel',
        });
        return;
      }
    }
  }

  const settings = repository.getSettings();
  let clientDisconnected = false;
  const clientAbort = new AbortController();
  const onClientClose = (): void => {
    if (!reply.raw.writableEnded) {
      clientDisconnected = true;
      clientAbort.abort(new Error('client_disconnect'));
    }
  };
  reply.raw.on('close', onClientClose);

  const finish = (): void => {
    reply.raw.off('close', onClientClose);
  };

  try {
    if (!clientDisconnected) {
      const attemptStartedAt = Date.now();
      const controller = new AbortController();
      const abortSignal = AbortSignal.any([controller.signal, clientAbort.signal]);
      let timeoutReason = '';
      const connectTimeout = setTimeout(() => {
        timeoutReason = 'connect_timeout';
        controller.abort(new Error('connect_timeout'));
      }, settings.connectTimeoutMs);

      let upstreamRequest: Record<string, unknown>;
      try {
        upstreamRequest =
          channel.protocol === 'anthropic'
            ? toAnthropicRequest(body, upstreamModel, channel.defaultMaxTokens)
            : channel.protocol === 'responses'
              ? toResponsesRequest(body, upstreamModel, channel.defaultMaxTokens)
              : toOpenAiRequest(body, upstreamModel, channel.defaultMaxTokens);
      } catch (error) {
        finish();
        const unsupported = error instanceof UnsupportedRequestError;
        sendOpenAiError(
          reply,
          unsupported ? 400 : 502,
          safeErrorMessage(error),
          unsupported ? error.code : 'conversion_error',
          unsupported ? 'invalid_request_error' : 'server_error',
          unsupported ? error.param : undefined,
        );
        repository.insertLog({
          createdAt: Math.floor(Date.now() / 1000),
          virtualModel: body.model,
          channelId: channel.id,
          channelName: channel.name,
          protocol: channel.protocol,
          upstreamModel,
          stream: body.stream,
          status: 'error',
          httpStatus: null,
          durationMs: Date.now() - startedAt,
          errorSummary: safeErrorMessage(error),
        });
        return;
      }

      const endpoint =
        channel.protocol === 'anthropic'
          ? 'messages'
          : channel.protocol === 'responses'
            ? 'responses'
            : 'chat/completions';
      let response: Response;
      try {
        response = await fetchImpl(joinUpstreamUrl(channel.baseUrl, endpoint), {
          method: 'POST',
          headers: {
            ...forwardedClientHeaders(request.headers),
            ...upstreamHeaders(channel),
          },
          body: JSON.stringify(upstreamRequest),
          signal: abortSignal,
        });
        clearTimeout(connectTimeout);
      } catch (error) {
        clearTimeout(connectTimeout);
        const durationMs = Date.now() - attemptStartedAt;
        if (clientDisconnected) {
          finish();
          repository.insertLog({
            createdAt: Math.floor(Date.now() / 1000),
            virtualModel: body.model,
            channelId: channel.id,
            channelName: channel.name,
            protocol: channel.protocol,
            upstreamModel,
            stream: body.stream,
            status: 'aborted',
            httpStatus: null,
            durationMs: Date.now() - startedAt,
            errorSummary: 'client disconnected',
          });
          return;
        }
        const reason = timeoutReason || safeErrorMessage(error);
        finish();
        sendOpenAiError(
          reply,
          502,
          `Upstream channel "${channel.name}" failed: ${reason}`,
          'upstream_error',
          'upstream_error',
          'model',
          [
            {
              channelId: channel.id,
              channelName: channel.name,
              protocol: channel.protocol,
              reason,
              durationMs,
            },
          ],
        );
        repository.insertLog({
          createdAt: Math.floor(Date.now() / 1000),
          virtualModel: body.model,
          channelId: channel.id,
          channelName: channel.name,
          protocol: channel.protocol,
          upstreamModel,
          stream: body.stream,
          status: 'error',
          httpStatus: null,
          durationMs: Date.now() - startedAt,
          errorSummary: reason,
        });
        return;
      }

      if (isRetryableStatus(response.status)) {
        const text = await response.text().catch(() => '');
        const summary = text.slice(0, 500) || `HTTP ${response.status}`;
        finish();
        sendOpenAiError(
          reply,
          response.status,
          `Upstream channel "${channel.name}" failed: ${summary}`,
          'upstream_error',
          'upstream_error',
          'model',
          [
            {
              channelId: channel.id,
              channelName: channel.name,
              protocol: channel.protocol,
              status: response.status,
              reason: summary,
              durationMs: Date.now() - attemptStartedAt,
            },
          ],
        );
        repository.insertLog({
          createdAt: Math.floor(Date.now() / 1000),
          virtualModel: body.model,
          channelId: channel.id,
          channelName: channel.name,
          protocol: channel.protocol,
          upstreamModel,
          stream: body.stream,
          status: 'upstream_error',
          httpStatus: response.status,
          durationMs: Date.now() - startedAt,
          errorSummary: summary,
        });
        return;
      }

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        const summary = text.slice(0, 500) || `HTTP ${response.status}`;
        finish();
        sendOpenAiError(
          reply,
          response.status,
          `Upstream channel "${channel.name}" failed: ${summary}`,
          'upstream_error',
          'upstream_error',
          undefined,
          [
            {
              channelId: channel.id,
              channelName: channel.name,
              protocol: channel.protocol,
              status: response.status,
              reason: summary,
              durationMs: Date.now() - attemptStartedAt,
            },
          ],
        );
        repository.insertLog({
          createdAt: Math.floor(Date.now() / 1000),
          virtualModel: body.model,
          channelId: channel.id,
          channelName: channel.name,
          protocol: channel.protocol,
          upstreamModel,
          stream: body.stream,
          status: 'upstream_error',
          httpStatus: response.status,
          durationMs: Date.now() - startedAt,
          errorSummary: summary,
        });
        return;
      }

      if (!body.stream) {
        let text: string;
        try {
          text = await readBodyWithTimeout(response, controller, settings.connectTimeoutMs);
        } catch (error) {
          if (clientDisconnected) {
            finish();
            repository.insertLog({
              createdAt: Math.floor(Date.now() / 1000),
              virtualModel: body.model,
              channelId: channel.id,
              channelName: channel.name,
              protocol: channel.protocol,
              upstreamModel,
              stream: false,
              status: 'aborted',
              httpStatus: response.status,
              durationMs: Date.now() - startedAt,
              errorSummary: 'client disconnected',
            });
            return;
          }
          const reason = 'response_timeout';
          finish();
          sendOpenAiError(
            reply,
            502,
            `Upstream channel "${channel.name}" failed: ${reason}`,
            'upstream_error',
            'upstream_error',
            'model',
            [
              {
                channelId: channel.id,
                channelName: channel.name,
                protocol: channel.protocol,
                status: response.status,
                reason,
                durationMs: Date.now() - attemptStartedAt,
              },
            ],
          );
          repository.insertLog({
            createdAt: Math.floor(Date.now() / 1000),
            virtualModel: body.model,
            channelId: channel.id,
            channelName: channel.name,
            protocol: channel.protocol,
            upstreamModel,
            stream: false,
            status: 'error',
            httpStatus: response.status,
            durationMs: Date.now() - startedAt,
            errorSummary: reason,
          });
          return;
        }
        try {
          const parsed = JSON.parse(text);
          const output =
            channel.protocol === 'anthropic'
              ? fromAnthropicResponse(parsed, body.model)
              : channel.protocol === 'responses'
                ? fromResponsesResponse(parsed, body.model)
                : fromOpenAiResponse(parsed, body.model);
          finish();
          reply.code(response.status).send(output);
          repository.insertLog({
            createdAt: Math.floor(Date.now() / 1000),
            virtualModel: body.model,
            channelId: channel.id,
            channelName: channel.name,
            protocol: channel.protocol,
            upstreamModel,
            stream: false,
            status: 'ok',
            httpStatus: response.status,
            durationMs: Date.now() - startedAt,
            errorSummary: null,
          });
          return;
        } catch (error) {
          finish();
          const message = safeErrorMessage(error);
          sendOpenAiError(
            reply,
            502,
            `Upstream channel "${channel.name}" returned an unsupported response: ${message}`,
            error instanceof UnsupportedResponseError ? error.code : 'bad_upstream_response',
            'server_error',
            undefined,
            [
              {
                channelId: channel.id,
                channelName: channel.name,
                protocol: channel.protocol,
                status: response.status,
                reason: message,
                durationMs: Date.now() - attemptStartedAt,
              },
            ],
          );
          repository.insertLog({
            createdAt: Math.floor(Date.now() / 1000),
            virtualModel: body.model,
            channelId: channel.id,
            channelName: channel.name,
            protocol: channel.protocol,
            upstreamModel,
            stream: false,
            status: 'upstream_error',
            httpStatus: response.status,
            durationMs: Date.now() - startedAt,
            errorSummary: message,
          });
          return;
        }
      }

      if (!response.body) {
        const reason = 'missing response body';
        finish();
        sendOpenAiError(
          reply,
          502,
          `Upstream channel "${channel.name}" failed: ${reason}`,
          'upstream_error',
          'upstream_error',
          'model',
          [
            {
              channelId: channel.id,
              channelName: channel.name,
              protocol: channel.protocol,
              status: response.status,
              reason,
              durationMs: Date.now() - attemptStartedAt,
            },
          ],
        );
        repository.insertLog({
          createdAt: Math.floor(Date.now() / 1000),
          virtualModel: body.model,
          channelId: channel.id,
          channelName: channel.name,
          protocol: channel.protocol,
          upstreamModel,
          stream: body.stream,
          status: 'error',
          httpStatus: response.status,
          durationMs: Date.now() - startedAt,
          errorSummary: reason,
        });
        return;
      }

      const streamResult = await consumeStream({
        request,
        reply,
        response,
        controller,
        timeoutReason: () => timeoutReason,
        setConnectTimeoutReason: () => {
          timeoutReason = 'connect_timeout';
        },
        setIdleTimeoutReason: () => {
          timeoutReason = 'stream_idle_timeout';
        },
        clientDisconnected: () => clientDisconnected,
        channel,
        exposedModel: body.model,
        includeUsage: body.includeUsage,
        connectTimeoutMs: settings.connectTimeoutMs,
        streamIdleTimeoutMs: settings.streamIdleTimeoutMs,
      });

      if (streamResult.kind === 'client_aborted') {
        finish();
        repository.insertLog({
          createdAt: Math.floor(Date.now() / 1000),
          virtualModel: body.model,
          channelId: channel.id,
          channelName: channel.name,
          protocol: channel.protocol,
          upstreamModel,
          stream: true,
          status: 'aborted',
          httpStatus: response.status,
          durationMs: Date.now() - startedAt,
          errorSummary: 'client disconnected',
        });
        return;
      }

      if (streamResult.kind === 'failed') {
        finish();
        sendOpenAiError(
          reply,
          502,
          `Upstream channel "${channel.name}" failed: ${streamResult.reason}`,
          'upstream_error',
          'upstream_error',
          'model',
          [
            {
              channelId: channel.id,
              channelName: channel.name,
              protocol: channel.protocol,
              status: response.status,
              reason: streamResult.reason,
              durationMs: Date.now() - attemptStartedAt,
            },
          ],
        );
        repository.insertLog({
          createdAt: Math.floor(Date.now() / 1000),
          virtualModel: body.model,
          channelId: channel.id,
          channelName: channel.name,
          protocol: channel.protocol,
          upstreamModel,
          stream: true,
          status: 'error',
          httpStatus: response.status,
          durationMs: Date.now() - startedAt,
          errorSummary: streamResult.reason,
        });
        return;
      }

      if (streamResult.kind === 'stream_error') {
        finish();
        if (!reply.raw.writableEnded) {
          reply.raw.write(dataEvent({ error: { message: streamResult.reason, type: 'upstream_error' } }));
          reply.raw.write(dataEvent('[DONE]'));
          reply.raw.end();
        }
        repository.insertLog({
          createdAt: Math.floor(Date.now() / 1000),
          virtualModel: body.model,
          channelId: channel.id,
          channelName: channel.name,
          protocol: channel.protocol,
          upstreamModel,
          stream: true,
          status: 'upstream_error',
          httpStatus: response.status,
          durationMs: Date.now() - startedAt,
          errorSummary: streamResult.reason,
        });
        return;
      }

      finish();
      repository.insertLog({
        createdAt: Math.floor(Date.now() / 1000),
        virtualModel: body.model,
        channelId: channel.id,
        channelName: channel.name,
        protocol: channel.protocol,
        upstreamModel,
        stream: true,
        status: 'ok',
        httpStatus: response.status,
        durationMs: Date.now() - startedAt,
        errorSummary: null,
      });
      return;
    }

    finish();
  } catch (error) {
    finish();
    if (!reply.sent && !reply.raw.headersSent) {
      sendOpenAiError(reply, 500, safeErrorMessage(error), 'internal_error', 'server_error');
    }
  }
}

type StreamResult =
  | { kind: 'ok' }
  | { kind: 'failed'; reason: string }
  | { kind: 'stream_error'; reason: string }
  | { kind: 'client_aborted' };

interface ConsumeStreamOptions {
  request: FastifyRequest;
  reply: FastifyReply;
  response: Response;
  controller: AbortController;
  timeoutReason: () => string;
  setConnectTimeoutReason: () => void;
  setIdleTimeoutReason: () => void;
  clientDisconnected: () => boolean;
  channel: ChannelRecord;
  exposedModel: string;
  includeUsage: boolean;
  connectTimeoutMs: number;
  streamIdleTimeoutMs: number;
}

async function consumeStream(options: ConsumeStreamOptions): Promise<StreamResult> {
  const reader = options.response.body!.getReader();
  const decoder = new TextDecoder();
  const transformer: StreamTransformer =
    options.channel.protocol === 'anthropic'
      ? createAnthropicStreamTransformer(options.exposedModel, options.includeUsage)
      : options.channel.protocol === 'responses'
        ? createResponsesStreamTransformer(options.exposedModel, options.includeUsage)
        : createOpenAiStreamTransformer(options.exposedModel);

  let wroteAnything = false;
  let timeout: NodeJS.Timeout | null = null;
  let activeTimeoutReason: 'connect' | 'idle' = 'connect';

  const clearTimer = (): void => {
    if (timeout) clearTimeout(timeout);
    timeout = null;
  };

  const armTimer = (reason: 'connect' | 'idle'): void => {
    clearTimer();
    activeTimeoutReason = reason;
    const ms = reason === 'connect' ? options.connectTimeoutMs : options.streamIdleTimeoutMs;
    timeout = setTimeout(() => {
      if (reason === 'connect') options.setConnectTimeoutReason();
      else options.setIdleTimeoutReason();
      options.controller.abort(new Error(`${reason}_timeout`));
    }, ms);
  };

  const write = (text: string): void => {
    if (!text) return;
    if (!wroteAnything) {
      options.reply.hijack();
      options.reply.raw.writeHead(options.response.status, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      wroteAnything = true;
    }
    options.reply.raw.write(text);
  };

  try {
    armTimer('connect');
    while (true) {
      let result: ReadableStreamReadResult<Uint8Array>;
      try {
        result = await reader.read();
      } catch (error) {
        clearTimer();
        if (options.clientDisconnected()) return { kind: 'client_aborted' };
        const reason = options.timeoutReason() || safeErrorMessage(error);
        if (!wroteAnything) return { kind: 'failed', reason };
        return { kind: 'stream_error', reason };
      }
      clearTimer();
      if (result.done) break;
      let output: string;
      try {
        output = transformer.push(decoder.decode(result.value, { stream: true }));
      } catch (error) {
        if (!wroteAnything) return { kind: 'failed', reason: safeErrorMessage(error) };
        throw error;
      }
      write(output);
      armTimer(wroteAnything ? 'idle' : 'connect');
    }
    const tail = transformer.push(decoder.decode());
    write(tail);
    write(transformer.flush());
    if (!wroteAnything) return { kind: 'failed', reason: 'upstream stream ended without data' };
    if (!options.reply.raw.writableEnded) options.reply.raw.end();
    return { kind: 'ok' };
  } finally {
    clearTimer();
    reader.releaseLock();
  }
}
