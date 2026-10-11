import type { FastifyReply } from 'fastify';

import type { ApiErrorBody, UpstreamProtocol } from '@aihub/shared';

export interface UpstreamAttempt {
  channelId: string;
  channelName: string;
  protocol: UpstreamProtocol;
  status?: number;
  reason: string;
  durationMs: number;
}

export class UnsupportedRequestError extends Error {
  readonly param: string;
  readonly code = 'unsupported_parameter';

  constructor(param: string, message?: string) {
    super(message ?? `Request field "${param}" is not supported`);
    this.param = param;
  }
}

export class UnsupportedResponseError extends Error {
  readonly code = 'unsupported_response';

  constructor(message: string) {
    super(message);
  }
}

export class AdminRequestError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(statusCode: number, message: string, code = 'admin_request_error') {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

export function sendOpenAiError(
  reply: FastifyReply,
  statusCode: number,
  message: string,
  code: string,
  type: string,
  param?: string,
  attempts?: UpstreamAttempt[],
): void {
  const body: ApiErrorBody = {
    error: {
      message,
      type,
      code,
      ...(param ? { param } : {}),
      ...(attempts?.length ? { upstream: { attempts } } : {}),
    },
  };
  reply.code(statusCode).send(body);
}

export function sendAdminError(reply: FastifyReply, error: unknown): void {
  if (error instanceof AdminRequestError) {
    reply.code(error.statusCode).send({ error: { message: error.message, code: error.code } });
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/UNIQUE constraint failed/i.test(message)) {
    reply.code(409).send({ error: { message, code: 'duplicate' } });
    return;
  }
  reply.code(500).send({ error: { message, code: 'internal_error' } });
}
