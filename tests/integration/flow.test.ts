import { createHmac } from 'node:crypto';
import { ScriptedModel, assistantMessage, functionCall } from '@openai/agents/testing';
import sharp from 'sharp';
import { afterEach, describe, expect, it } from 'vitest';
import type { AppConfig } from '../../src/config.js';
import { FakeMessenger } from '../../src/sim/fake-messenger.js';
import { loadMediaSpec } from '../../src/sim/fixtures.js';
import { StubImageGenerator } from '../../src/sim/stub-image-generator.js';
import { createServices } from '../../src/services.js';
import { buildApp } from '../../src/webhook.js';

const appSecret = 'test-app-secret';
const sender = '15551234567';

const config: AppConfig = {
  environment: 'test',
  host: '127.0.0.1',
  port: 3000,
  openRouter: {
    apiKey: 'test-key',
    baseUrl: 'https://openrouter.test/api/v1',
    agentModel: 'test-model',
    imageModel: 'test-image-model',
    siteUrl: 'https://sticker.example',
    appName: 'Sticker test',
  },
  whatsapp: {
    accessToken: 'token',
    phoneNumberId: 'phone-1',
    verifyToken: 'verify',
    appSecret,
    graphApiVersion: 'v25.0',
    allowedNumbers: new Set([sender]),
  },
  memoryTtlMs: 60_000,
  dailyGenerationLimit: 20,
  batchWindowMs: 0,
  maxInputImageBytes: 10_000_000,
  databasePath: ':memory:',
};

describe('end-to-end flow through the webhook', () => {
  let app: ReturnType<typeof buildApp> | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('welcomes a new number, then remixes a sticker sent after a question', async () => {
    const messenger = new FakeMessenger();
    const imageGenerator = new StubImageGenerator();
    const model = new ScriptedModel([
      [assistantMessage('Oi! Me mande uma figurinha ou uma descrição.')],
      [assistantMessage('O que você quer mudar nessa figurinha?')],
      [functionCall('generate_image', {
        prompt: 'The cat from reference 1 wears a cowboy hat.',
        reference_asset_ids: ['sticker_1'],
      }, { callId: 'call-1' })],
      [functionCall('make_sticker', { asset_id: 'image_2' }, { callId: 'call-2' })],
      [functionCall('send_sticker', { asset_id: 'sticker_3' }, { callId: 'call-3' })],
      [assistantMessage('Aqui está, com chapéu!')],
    ]);
    const services = createServices(config, {
      messenger,
      imageGenerator,
      modelProvider: { getModel: () => model },
    });
    app = buildApp({ config, bot: services.bot, db: services.db, pendingInputs: services.pendingInputs });

    await post(app, inbound({ id: 'wamid.0', type: 'text', text: { body: 'oi' } }));
    await app.drainMessageQueue();
    expect(messenger.outbound[0]).toMatchObject({ body: expect.stringContaining('Bem-vindo') });
    expect(services.accounts.findUser(sender)).toMatchObject({ whatsappId: sender, status: 'active' });

    messenger.media.set('media-sticker', await loadMediaSpec('sticker:red'));
    await post(app, inbound({ id: 'wamid.1', type: 'sticker', sticker: { id: 'media-sticker', mime_type: 'image/webp' } }));
    await app.drainMessageQueue();
    const question = messenger.outbound.at(-1);
    expect(question).toMatchObject({ body: 'O que você quer mudar nessa figurinha?' });
    expect(imageGenerator.calls).toHaveLength(0);

    const start = messenger.outbound.length;
    await post(app, inbound({ id: 'wamid.2', type: 'text', text: { body: 'coloca um chapéu de cowboy nele' } }));
    await app.drainMessageQueue();

    const replies = messenger.outbound.slice(start);
    expect(replies.map((message) => message.type)).toEqual(['text', 'sticker', 'text']);
    expect(replies[0]).toMatchObject({ body: expect.stringContaining('Gerando') });
    expect(imageGenerator.calls[0]?.references[0]?.mimeType).toBe('image/png');

    const sticker = replies[1];
    if (sticker?.type !== 'sticker') throw new Error('expected a sticker');
    const metadata = await sharp(sticker.data).metadata();
    expect(metadata.format).toBe('webp');
    expect(metadata.width).toBe(512);
    expect(metadata.height).toBe(512);

    expect(replies[2]).toMatchObject({ body: 'Aqui está, com chapéu!' });
    model.assertComplete();
  });

  it('ignores a duplicate webhook delivery', async () => {
    const messenger = new FakeMessenger();
    const model = new ScriptedModel([[assistantMessage('Oi!')]]);
    const services = createServices(config, {
      messenger,
      imageGenerator: new StubImageGenerator(),
      modelProvider: { getModel: () => model },
    });
    app = buildApp({ config, bot: services.bot, db: services.db, pendingInputs: services.pendingInputs });

    const body = inbound({ id: 'wamid.dup', type: 'text', text: { body: 'oi' } });
    await post(app, body);
    await post(app, body);
    await app.drainMessageQueue();

    expect(messenger.outbound.filter((message) => message.type === 'text')).toHaveLength(2);
    expect(model.calls).toHaveLength(1);
  });

  it('ignores numbers that are not on the allowlist', async () => {
    const messenger = new FakeMessenger();
    const services = createServices(config, {
      messenger,
      imageGenerator: new StubImageGenerator(),
      modelProvider: { getModel: () => new ScriptedModel([]) },
    });
    app = buildApp({ config, bot: services.bot, db: services.db, pendingInputs: services.pendingInputs });

    const body = inbound({ id: 'wamid.stranger', from: '15550000000', type: 'text', text: { body: 'oi' } });
    await post(app, body);
    await app.drainMessageQueue();

    expect(messenger.outbound).toHaveLength(0);
    expect(services.accounts.findUser('15550000000')).toBeUndefined();
  });
});

function inbound(message: Record<string, unknown>): string {
  return JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [{
      id: 'entry-1',
      changes: [{
        field: 'messages',
        value: {
          messaging_product: 'whatsapp',
          messages: [{ from: sender, timestamp: '1700000000', ...message }],
        },
      }],
    }],
  });
}

async function post(instance: ReturnType<typeof buildApp>, body: string) {
  const signature = createHmac('sha256', appSecret).update(body).digest('hex');
  const response = await instance.inject({
    method: 'POST',
    url: '/webhook',
    headers: {
      'content-type': 'application/json',
      'x-hub-signature-256': `sha256=${signature}`,
    },
    payload: body,
  });
  if (response.statusCode !== 200) throw new Error(`Webhook returned ${response.statusCode}`);
}
