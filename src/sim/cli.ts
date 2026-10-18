import 'dotenv/config';
import { createHmac } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { loadConfig } from '../config.js';
import { createServices } from '../services.js';
import { buildApp } from '../webhook.js';
import { FakeMessenger, type OutboundMessage } from './fake-messenger.js';
import { loadMediaSpec, SAMPLE_COLORS } from './fixtures.js';
import { StubImageGenerator } from './stub-image-generator.js';

const SIM_SENDER = '15550000001';
const APP_SECRET = 'sim-app-secret';
const SIM_PORT = process.env.SIM_PORT ?? '3100';
const useRealImages = process.argv.includes('--real-images');
const simDir = join(process.cwd(), 'tmp', 'sim');
const outputDir = join(simDir, 'out');
const databasePath = join(simDir, 'sticker-agent.db');

const HELP = [
  'Commands:',
  '  <text>                          send a text message',
  '  /sticker <spec|file>            send a sticker',
  '  /photo <spec|file> [caption]    send a photo, optionally with a caption',
  '  /new                            reset the conversation',
  '  /quit                           exit',
  `Samples: sticker:<color> or photo:<color>, colors: ${Object.keys(SAMPLE_COLORS).join(', ')}.`,
].join('\n');

const config = loadConfig({
  ...process.env,
  NODE_ENV: 'test',
  HOST: '127.0.0.1',
  PORT: SIM_PORT,
  DATABASE_PATH: databasePath,
  WHATSAPP_ACCESS_TOKEN: 'sim',
  WHATSAPP_PHONE_NUMBER_ID: 'sim',
  WHATSAPP_VERIFY_TOKEN: 'sim',
  WHATSAPP_APP_SECRET: APP_SECRET,
  WHATSAPP_ALLOWED_NUMBERS: SIM_SENDER,
});

await mkdir(outputDir, { recursive: true });
// Start every run with a fresh database so the first-message welcome can be repeated.
for (const suffix of ['', '-wal', '-shm']) await rm(`${databasePath}${suffix}`, { force: true });
let stickerCount = 0;
const messenger = new FakeMessenger(async (message: OutboundMessage) => {
  if (message.type === 'text') {
    console.log(`\nbot> ${message.body}\n`);
    return;
  }
  stickerCount += 1;
  const path = join(outputDir, `sticker-${stickerCount}.webp`);
  await writeFile(path, message.data);
  console.log(`\nbot> [sticker saved: ${path}]\n`);
});

const services = createServices(config, {
  messenger,
  imageGenerator: useRealImages ? undefined : new StubImageGenerator(),
});
const app = buildApp({ config, bot: services.bot, db: services.db });
const url = await app.listen({ host: config.host, port: config.port });

console.log(`Sticker Agent local harness at ${url} (images: ${useRealImages ? 'OpenRouter' : 'stub'}). Sender ${SIM_SENDER}.`);
console.log(`Sender ${SIM_SENDER} is allowed. Its account is created on the first message.`);
console.log(HELP);

const rl = createInterface({ input: process.stdin, output: process.stdout });
let counter = 0;

try {
  while (true) {
    const line = (await rl.question('\nyou> ')).trim();
    if (line === '/quit') break;
    if (!line) continue;

    counter += 1;
    let inbound: Record<string, unknown>;
    try {
      inbound = await buildInbound(line, counter, messenger);
    } catch (error) {
      console.log(error instanceof Error ? error.message : String(error));
      continue;
    }

    const body = JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [{
        id: 'sim',
        changes: [{
          field: 'messages',
          value: {
            messaging_product: 'whatsapp',
            metadata: { display_phone_number: 'sim', phone_number_id: 'sim' },
            messages: [inbound],
          },
        }],
      }],
    });
    const signature = createHmac('sha256', APP_SECRET).update(body).digest('hex');

    const response = await fetch(`${url}/webhook`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': `sha256=${signature}`,
      },
      body,
    });
    if (!response.ok) {
      console.log(`Webhook rejected: HTTP ${response.status}`);
      continue;
    }

    console.log('… thinking');
    await app.drainMessageQueue();
  }
} catch {
  // Ctrl+D or a closed stdin ends the session.
} finally {
  rl.close();
  await app.close();
  services.db.close();
}

async function buildInbound(
  line: string,
  n: number,
  messengerRef: FakeMessenger,
): Promise<Record<string, unknown>> {
  const base = {
    from: SIM_SENDER,
    id: `wamid.sim.${n}`,
    timestamp: String(Math.floor(Date.now() / 1000)),
  };

  const media = /^\/(sticker|photo)\s+(\S+)(?:\s+(.*))?$/.exec(line);
  if (!media) return { ...base, type: 'text', text: { body: line } };

  const [, command, spec, caption] = media;
  const asset = await loadMediaSpec(spec ?? '');
  const mediaId = `sim-media-${n}`;
  messengerRef.media.set(mediaId, asset);

  if (command === 'sticker') {
    return { ...base, type: 'sticker', sticker: { id: mediaId, mime_type: asset.mimeType } };
  }
  return {
    ...base,
    type: 'image',
    image: { id: mediaId, mime_type: asset.mimeType, ...(caption ? { caption } : {}) },
  };
}
