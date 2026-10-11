import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import type { FastifyInstance } from 'fastify';

import { buildApp } from '../src/app.js';
import { createDatabase, Repository } from '../src/db.js';

export interface GatewayContext {
  app: FastifyInstance;
  repository: Repository;
  baseUrl: string;
  gatewayToken: string;
  close(): Promise<void>;
}

export async function startGateway(fetchImpl?: typeof fetch): Promise<GatewayContext> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aihub-test-'));
  const database = createDatabase(path.join(tempDir, 'aihub.sqlite'));
  const repository = new Repository(database.raw);
  const app = await buildApp({
    repository,
    webDistDir: path.join(tempDir, 'web-dist'),
    ...(fetchImpl ? { fetchImpl } : {}),
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('Gateway did not listen on a TCP port');
  const settings = repository.getSettings();
  return {
    app,
    repository,
    baseUrl: `http://127.0.0.1:${address.port}`,
    gatewayToken: settings.gatewayToken,
    async close() {
      await app.close();
      database.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

export interface FakeCall {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
  aborted: boolean;
}

export interface FakeUpstream {
  baseUrl: string;
  calls: FakeCall[];
  close(): Promise<void>;
}

export async function startFakeUpstream(
  handler: (call: FakeCall, request: http.IncomingMessage, response: http.ServerResponse) => void | Promise<void>,
): Promise<FakeUpstream> {
  const calls: FakeCall[] = [];
  const server = http.createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const call: FakeCall = {
      method: request.method ?? 'GET',
      url: request.url ?? '/',
      headers: request.headers,
      body: Buffer.concat(chunks).toString('utf8'),
      aborted: false,
    };
    calls.push(call);
    request.on('aborted', () => {
      call.aborted = true;
    });
    response.on('close', () => {
      if (!response.writableEnded) call.aborted = true;
    });
    try {
      await handler(call, request, response);
    } catch (error) {
      response.statusCode = 500;
      response.end(error instanceof Error ? error.message : String(error));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fake upstream did not listen on a TCP port');
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    calls,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export function seedChannel(
  repository: Repository,
  input: {
    name: string;
    protocol: 'openai' | 'responses' | 'anthropic';
    baseUrl: string;
    apiKey?: string;
    enabled?: boolean;
    defaultMaxTokens?: number;
    models?: string[];
  },
) {
  return repository.createChannel({
    name: input.name,
    protocol: input.protocol,
    baseUrl: input.baseUrl,
    apiKey: input.apiKey ?? 'sk-test',
    defaultMaxTokens: input.defaultMaxTokens ?? 4096,
    enabled: input.enabled ?? true,
    models: input.models ?? [],
  });
}
