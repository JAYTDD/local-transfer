import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createDatabase, Repository } from './db.js';

const config = loadConfig();
const database = createDatabase(config.databasePath);
const repository = new Repository(database.raw);
const app = await buildApp({
  repository,
  webDistDir: config.webDistDir,
  logger: true,
});

await app.listen({ host: config.host, port: config.port });
console.log(`AiHub listening on http://${config.host}:${config.port}`);
console.log(`Admin UI: http://${config.host}:${config.port}/admin/`);

const shutdown = async (): Promise<void> => {
  await app.close();
  database.close();
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
