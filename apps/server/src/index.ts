import { fileURLToPath } from 'node:url';
import { buildApp } from './app.js';
import { ensureFirstAdmin } from './bootstrap.js';
import { loadConfig } from './config.js';
import { createPool, migrate } from './db.js';

const config = loadConfig();
await migrate(config.databaseUrl, fileURLToPath(new URL('../migrations', import.meta.url)));
const pool = createPool(config.databaseUrl);
const app = await buildApp(config, pool);
await ensureFirstAdmin(pool, config, app.log);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void app.close().then(() => pool.end());
  });
}

await app.listen({ port: config.port, host: config.host });
