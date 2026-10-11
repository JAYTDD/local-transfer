import type { UpstreamProtocol } from '@aihub/shared';

import {
  toAnthropicRequest,
  toOpenAiRequest,
  toResponsesRequest,
  type CanonicalChatRequest,
} from './converters/request.js';
import { AdminRequestError } from './errors.js';

export interface UpstreamCredential {
  protocol: UpstreamProtocol;
  baseUrl: string;
  apiKey: string;
}

export interface TestableChannel extends UpstreamCredential {
  defaultMaxTokens: number;
}

export interface ChannelTestOutcome {
  ok: boolean;
  latencyMs: number;
  httpStatus: number | null;
  errorSummary: string | null;
}

export function upstreamHeaders(credential: UpstreamCredential): Record<string, string> {
  if (credential.protocol === 'anthropic') {
    return {
      'content-type': 'application/json',
      'x-api-key': credential.apiKey,
      'anthropic-version': '2023-06-01',
    };
  }
  if (credential.protocol === 'responses') {
    return {
      'content-type': 'application/json',
      authorization: `Bearer ${credential.apiKey}`,
    };
  }
  return {
    'content-type': 'application/json',
    authorization: `Bearer ${credential.apiKey}`,
  };
}

export function joinUpstreamUrl(baseUrl: string, suffix: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/${suffix.replace(/^\/+/, '')}`;
}

export async function pullUpstreamModels(
  credential: UpstreamCredential,
  timeoutMs: number,
  fetchImpl: typeof fetch = fetch,
): Promise<{ models: Array<{ id: string; displayName?: string }>; latencyMs: number }> {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error('connect_timeout')), timeoutMs);
  try {
    const response = await fetchImpl(joinUpstreamUrl(credential.baseUrl, 'models'), {
      method: 'GET',
      headers: upstreamHeaders(credential),
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) {
      throw new AdminRequestError(
        response.status,
        `Upstream model list failed with HTTP ${response.status}: ${text.slice(0, 300)}`,
        'upstream_error',
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new AdminRequestError(502, 'Upstream model list returned non-JSON content', 'upstream_error');
    }
    const data =
      typeof parsed === 'object' && parsed !== null && Array.isArray((parsed as { data?: unknown }).data)
        ? ((parsed as { data: unknown[] }).data as unknown[])
        : [];
    const models = data
      .map((item) => {
        if (typeof item === 'string') return { id: item };
        if (typeof item !== 'object' || item === null) return null;
        const record = item as Record<string, unknown>;
        const id = typeof record.id === 'string' ? record.id : null;
        if (!id) return null;
        const displayName =
          typeof record.display_name === 'string'
            ? record.display_name
            : typeof record.name === 'string'
              ? record.name
              : undefined;
        return { id, ...(displayName ? { displayName } : {}) };
      })
      .filter((item): item is { id: string; displayName?: string } => item !== null);
    return { models, latencyMs: Date.now() - startedAt };
  } catch (error) {
    if (error instanceof AdminRequestError) throw error;
    if (controller.signal.aborted) throw new AdminRequestError(504, 'Upstream model list timed out', 'timeout');
    throw new AdminRequestError(502, error instanceof Error ? error.message : String(error), 'upstream_error');
  } finally {
    clearTimeout(timeout);
  }
}

export async function testUpstreamChannel(
  channel: TestableChannel,
  model: string,
  timeoutMs: number,
  fetchImpl: typeof fetch = fetch,
): Promise<ChannelTestOutcome> {
  const startedAt = Date.now();
  const request: CanonicalChatRequest = {
    model,
    messages: [{ role: 'user', content: 'ping' }],
    max_tokens: 16,
    stream: false,
    includeUsage: false,
  };
  const body =
    channel.protocol === 'anthropic'
      ? toAnthropicRequest(request, model, channel.defaultMaxTokens)
      : channel.protocol === 'responses'
        ? toResponsesRequest(request, model, channel.defaultMaxTokens)
        : toOpenAiRequest(request, model, channel.defaultMaxTokens);
  const endpoint =
    channel.protocol === 'anthropic' ? 'messages' : channel.protocol === 'responses' ? 'responses' : 'chat/completions';
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error('connect_timeout')), timeoutMs);
  try {
    const response = await fetchImpl(joinUpstreamUrl(channel.baseUrl, endpoint), {
      method: 'POST',
      headers: upstreamHeaders(channel),
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text().catch(() => '');
    const latencyMs = Date.now() - startedAt;
    if (response.ok) {
      return { ok: true, latencyMs, httpStatus: response.status, errorSummary: null };
    }
    return {
      ok: false,
      latencyMs,
      httpStatus: response.status,
      errorSummary: text.slice(0, 300) || `HTTP ${response.status}`,
    };
  } catch (error) {
    return {
      ok: false,
      latencyMs: Date.now() - startedAt,
      httpStatus: null,
      errorSummary: controller.signal.aborted
        ? 'connect_timeout'
        : error instanceof Error
          ? error.message
          : String(error),
    };
  } finally {
    clearTimeout(timeout);
  }
}
