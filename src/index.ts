import 'dotenv/config';
import { loadConfig } from './config.js';
import { createServices } from './services.js';
import { buildApp } from './webhook.js';

const config = loadConfig();
const { bot, db, pendingInputs } = createServices(config);
const app = buildApp({ config, bot, db, pendingInputs });

try {
  await app.listen({ host: config.host, port: config.port });
  app.log.info(`WhatsApp Sticker Agent listening on ${config.host}:${config.port}`);
} catch (error) {
  app.log.error(error);
  process.exitCode = 1;
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void app.close().finally(() => {
      db.close();
      process.exit(0);
    });
  });
}
