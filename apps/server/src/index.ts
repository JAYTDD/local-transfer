import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createDatabase, Repository } from './db.js';
import { createRelayModule, mapRelayLog } from './relay.js';

const config = loadConfig();
const database = createDatabase(config.databasePath);
const repository = new Repository(database.raw);

// 订阅中转模块：面板展示的端点由宿主宣告，所以传的是当前配置里的真实地址
const relay = createRelayModule({
  endpoint: () => `http://${config.host}:${config.port}/v1`,
  onLog: (entry) => repository.insertLog(mapRelayLog(entry)),
});

const app = await buildApp({
  repository,
  webDistDir: config.webDistDir,
  logger: true,
  relay,
});

// 按设置装配订阅中转模块。装配过程会读本机凭据、起 loopback shim、拉模型目录，
// 所以放在 listen 之前——端口一就绪，relay 的通道就是可用的（与原项目语义一致）。
// 装配失败只会在日志里告警，不会拦住 AiHub 本体启动。
const settings = repository.getSettings();
repository.pruneRequestLogs(settings.logRetentionDays);
await relay.reconfigure({ enabled: settings.relayEnabled, channels: settings.relayChannels });

await app.listen({ host: config.host, port: config.port });
console.log(`AiHub listening on http://${config.host}:${config.port}`);
console.log(`Admin UI: http://${config.host}:${config.port}/admin/`);
console.log(`Relay admin: http://${config.host}:${config.port}/admin/relay`);

const shutdown = async (): Promise<void> => {
  await relay.dispose();
  await app.close();
  database.close();
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
