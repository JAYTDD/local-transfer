import fs from 'node:fs';
import type { ServerResponse } from 'node:http';
import path from 'node:path';

import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';

import type { ModelList } from './model-list.js';
import type { RelayModule } from './relay.js';

import { bearerToken, tokensEqual } from './auth.js';
import { Repository } from './db.js';
import { sendOpenAiError } from './errors.js';
import { anthropicMessagesToChat } from './messages-inbound.js';
import { handleChatCompletions } from './proxy.js';
import { registerAdminRoutes } from './admin-routes.js';
import { listPublicModels } from './model-list.js';
import { hasRelayPrefix } from './relay.js';

export interface BuildAppOptions {
  repository: Repository;
  webDistDir: string;
  fetchImpl?: typeof fetch;
  logger?: boolean;
  /** 订阅中转（relay）模块；缺省表示不接入，相关路由全部不注册 */
  relay?: RelayModule;
}

/** 直接写 Node 响应（hijack 之后 Fastify 不再接管，只能自己写） */
function writeRawJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

/**
 * 订阅中转面板 API：管理端通过 `/api/admin/relay/panel/*` 取数据。
 *
 * relay 的面板数据层内部仍按 `/panel/api/*` 匹配路由，这里只做一次路径前缀
 * 重写；relay 用 Node 原生 res 写，所以先 hijack，未命中的路径补 JSON 404。
 */
function registerRelayPanelApi(app: FastifyInstance, relay: RelayModule): void {
  app.all('/api/admin/relay/panel/*', async (request, reply) => {
    const gateway = relay.gateway();
    if (!gateway) {
      reply.code(503).send({ error: { message: 'relay module is disabled' } });
      return;
    }
    const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
    const internalPathname = pathname.replace(/^\/api\/admin\/relay\/panel/, '/panel/api');
    reply.hijack();
    const res = reply.raw;
    try {
      const handled = await gateway.panelApi.handle(
        {
          method: request.method,
          url: request.url,
          headers: request.headers,
          body: request.body ?? {},
        },
        res,
        internalPathname,
      );
      if (!handled) writeRawJson(res, 404, { error: { message: `no such panel route: ${pathname}` } });
    } catch (error) {
      if (!res.headersSent) {
        writeRawJson(res, 500, {
          error: { message: error instanceof Error ? error.message : String(error) },
        });
      } else {
        res.end();
      }
    }
  });
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

  app.get('/v1/models', async () => {
    const gateway = options.relay?.gateway() ?? null;
    return {
      object: 'list',
      data: [
        ...listPublicModels(options.repository),
        // 订阅中转的六个前缀模型直接并入同一个列表，客户端一次拉全
        ...(gateway ? gateway.listModels() : []),
      ],
    } satisfies ModelList;
  });

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
        id: `${channel.name}/${model}`,
        object: 'model',
        created: channel.createdAt,
        owned_by: channel.name,
      })),
    } satisfies ModelList;
  });

  async function dispatchChat(request: { body?: unknown; method?: string; url?: string; headers: import('fastify').FastifyRequest['headers'] }, reply: import('fastify').FastifyReply): Promise<void> {
    // 订阅中转优先：模型名带它的六个前缀之一时整单交给 relay，不再进 AiHub 的
    // 渠道路由。前缀是 relay 的命名空间（AiHub 的渠道模型名不带斜杠），
    // 正常情况下不会撞车；真撞了也以 relay 为准，行为才可预测。
    const gateway = options.relay?.gateway() ?? null;
    const model = (request.body as { model?: unknown } | null | undefined)?.model;
    if (gateway && hasRelayPrefix(model, gateway.prefixes)) {
      reply.hijack();
      try {
        await gateway.handleChat(request.body, reply.raw);
      } catch (error) {
        // hijack 之后 Fastify 的错误处理不再接管，兜底只能自己写
        if (!reply.raw.headersSent) {
          writeRawJson(reply.raw, 500, {
            error: { message: error instanceof Error ? error.message : String(error) },
          });
        } else {
          reply.raw.end();
        }
      }
      return;
    }
    await handleChatCompletions(request as import('fastify').FastifyRequest, reply, {
      repository: options.repository,
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    });
  }

  app.post('/v1/chat/completions', async (request, reply) => {
    await dispatchChat(request, reply);
  });

  app.post('/v1/messages', async (request, reply) => {
    let chatBody: Record<string, unknown>;
    try {
      chatBody = anthropicMessagesToChat(request.body);
    } catch (error) {
      sendOpenAiError(
        reply,
        400,
        error instanceof Error ? error.message : 'invalid messages request',
        'invalid_request_error',
        'invalid_request_error',
        'messages',
      );
      return;
    }
    request.body = chatBody;
    await dispatchChat(request, reply);
  });

  app.post('/v1/channels/:channelId/chat/completions', async (request, reply) => {
    const { channelId } = request.params as { channelId: string };
    await handleChatCompletions(request, reply, {
      repository: options.repository,
      channelId,
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    });
  });

  await registerAdminRoutes(app, options.repository, options.relay ?? null);

  if (options.relay) registerRelayPanelApi(app, options.relay);

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
