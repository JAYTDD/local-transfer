import fs from 'node:fs';
import path from 'node:path';

import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';

import type { ModelList } from './model-list.js';

import { bearerToken, tokensEqual } from './auth.js';
import { Repository } from './db.js';
import { sendOpenAiError } from './errors.js';
import { handleChatCompletions } from './proxy.js';
import { registerAdminRoutes } from './admin-routes.js';
import { listPublicModels } from './model-list.js';

export interface BuildAppOptions {
  repository: Repository;
  webDistDir: string;
  fetchImpl?: typeof fetch;
  logger?: boolean;
}

export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger ?? false,
    bodyLimit: 10 * 1024 * 1024,
  });

  app.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith('/v1/')) return;
    const settings = options.repository.getSettings();
    const token = bearerToken(request.headers.authorization);
    if (!tokensEqual(token, settings.gatewayToken)) {
      sendOpenAiError(reply, 401, 'Invalid gateway token', 'invalid_api_key', 'authentication_error');
    }
  });

  app.get('/healthz', async () => ({
    ok: true,
    service: 'aihub',
    time: new Date().toISOString(),
  }));

  app.get('/v1/models', async () => ({
    object: 'list',
    data: listPublicModels(options.repository),
  } satisfies ModelList));

  app.get('/v1/channels/:channelId/models', async (request, reply) => {
    const { channelId } = request.params as { channelId: string };
    const channel = options.repository.getChannel(channelId);
    if (!channel) {
      sendOpenAiError(
        reply,
        404,
        `Channel "${channelId}" was not found`,
        'channel_not_found',
        'invalid_request_error',
        'channelId',
      );
      return;
    }
    return {
      object: 'list',
      data: channel.models.map((model) => ({
        id: model,
        object: 'model',
        created: channel.createdAt,
        owned_by: channel.name,
      })),
    } satisfies ModelList;
  });

  app.post('/v1/chat/completions', async (request, reply) => {
    await handleChatCompletions(request, reply, {
      repository: options.repository,
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    });
  });

  app.post('/v1/channels/:channelId/chat/completions', async (request, reply) => {
    const { channelId } = request.params as { channelId: string };
    await handleChatCompletions(request, reply, {
      repository: options.repository,
      channelId,
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    });
  });

  await registerAdminRoutes(app, options.repository);

  const indexFile = path.join(options.webDistDir, 'index.html');
  if (fs.existsSync(indexFile)) {
    await app.register(fastifyStatic, {
      root: options.webDistDir,
      prefix: '/admin/',
      wildcard: false,
    });
    app.get('/admin', async (_request, reply) => reply.redirect('/admin/'));
    app.get('/admin/*', async (_request, reply) => reply.sendFile('index.html'));
  } else {
    app.get('/admin', async (_request, reply) => {
      reply.type('text/html').send('<h1>AiHub admin is not built</h1><p>Run npm run build.</p>');
    });
    app.get('/admin/*', async (_request, reply) => {
      reply.type('text/html').send('<h1>AiHub admin is not built</h1><p>Run npm run build.</p>');
    });
  }

  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith('/v1/')) {
      sendOpenAiError(reply, 404, `Route "${request.url}" was not found`, 'not_found', 'invalid_request_error');
      return;
    }
    reply.code(404).send({ error: { message: 'Route not found', code: 'not_found' } });
  });

  app.setErrorHandler((error: Error & { statusCode?: number; code?: string }, request, reply) => {
    if (reply.sent) return;
    const statusCode = error.statusCode ?? 500;
    if (request.url.startsWith('/v1/')) {
      const isParseError = error.code === 'FST_ERR_CTP_INVALID_JSON_BODY' || statusCode === 400;
      sendOpenAiError(
        reply,
        statusCode,
        error.message,
        isParseError ? 'invalid_json' : 'internal_error',
        isParseError ? 'invalid_request_error' : 'server_error',
      );
      return;
    }
    reply.code(statusCode).send({
      error: { message: error.message, code: error.code ?? 'internal_error' },
    });
  });

  return app;
}
