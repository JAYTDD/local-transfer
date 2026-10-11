import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface AppConfig {
  host: string;
  port: number;
  dataDir: string;
  databasePath: string;
  webDistDir: string;
}

export function loadConfig(): AppConfig {
  const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
  const dataDir = process.env.AIHUB_DATA_DIR
    ? path.resolve(repoRoot, process.env.AIHUB_DATA_DIR)
    : path.resolve(repoRoot, 'data');

  return {
    host: process.env.AIHUB_HOST ?? '127.0.0.1',
    port: Number.parseInt(process.env.AIHUB_PORT ?? '8787', 10),
    dataDir,
    databasePath: path.join(dataDir, 'aihub.sqlite'),
    webDistDir: path.resolve(repoRoot, 'apps/web/dist'),
  };
}
