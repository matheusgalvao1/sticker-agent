import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../src/config.js';
import type { StickerBotService } from '../src/bot/sticker-bot.js';
import { openDatabase } from '../src/db/database.js';
import { buildApp } from '../src/webhook.js';

const appSecret = 'test-meta-app-secret';
const allowedSender = '15551234567';

const config: AppConfig = {
  environment: 'test',
  host: '127.0.0.1',
  port: 3000,
  openRouter: {
    apiKey: 'test-openrouter-key',
    baseUrl: 'https://openrouter.ai/api/v1',
    agentModel: 'openai/gpt-6-luna',
    imageModel: 'openai/gpt-image-2.5-sunburst',
    siteUrl: 'https://sticker.example',
    appName: 'Sticker bot test',
  },
  whatsapp: {
    accessToken: 'test-whatsapp-token',
    phoneNumberId: 'test-phone-id',
    verifyToken: 'verify-me',
    appSecret,
    graphApiVersion: 'v25.0',
    allowedNumbers: new Set([allowedSender]),
  },
  memoryTtlMs: 60_000,
  dailyGenerationLimit: 20,
  maxInputImageBytes: 10_000_000,
  databasePath: ':memory:',
};

describe('WhatsApp webhook', () => {
  let app: ReturnType<typeof buildApp> | undefined;

  afterEach(async () => {
    if (app) await app.close();
    app = undefined;
  });

  it('answers Meta’s webhook verification challenge', async () => {
    app = buildApp({
      config,
      bot: { handleIncoming: vi.fn() } as unknown as StickerBotService,
      db: openDatabase(':memory:'),
    });

    const response = await app.inject({
      method: 'GET',
      url: '/webhook?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=challenge-123',
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('challenge-123');
  });

  it('validates Meta’s HMAC signature and queues allowed messages once', async () => {
    const handleIncoming = vi.fn(async () => undefined);
    app = buildApp({
      config,
      bot: { handleIncoming } as unknown as StickerBotService,
      db: openDatabase(':memory:'),
    });
    const payload = webhookPayload('wamid-test-1');
    const signature = createHmac('sha256', appSecret).update(payload).digest('hex');

    const response = await app.inject({
      method: 'POST',
      url: '/webhook',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': `sha256=${signature}`,
      },
      payload,
    });

    expect(response.statusCode).toBe(200);
    await vi.waitFor(() => expect(handleIncoming).toHaveBeenCalledOnce());

    const duplicate = await app.inject({
      method: 'POST',
      url: '/webhook',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': `sha256=${signature}`,
      },
      payload,
    });

    expect(duplicate.statusCode).toBe(200);
    expect(handleIncoming).toHaveBeenCalledOnce();
  });

  it('rejects an invalid signature and ignores senders outside the allowlist', async () => {
    const handleIncoming = vi.fn(async () => undefined);
    app = buildApp({
      config,
      bot: { handleIncoming } as unknown as StickerBotService,
      db: openDatabase(':memory:'),
    });
    const payload = webhookPayload('wamid-untrusted', '15550000000');

    const badSignature = await app.inject({
      method: 'POST',
      url: '/webhook',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=deadbeef' },
      payload,
    });
    expect(badSignature.statusCode).toBe(401);

    const signature = createHmac('sha256', appSecret).update(payload).digest('hex');
    const unauthorized = await app.inject({
      method: 'POST',
      url: '/webhook',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': `sha256=${signature}`,
      },
      payload,
    });

    expect(unauthorized.statusCode).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(handleIncoming).not.toHaveBeenCalled();
  });

  it('keeps unfinished messages and runs them when the app starts again', async () => {
    const db = openDatabase(':memory:');
    const payload = webhookPayload('wamid-restart');
    const hung = vi.fn(() => new Promise<void>(() => undefined));
    const interrupted = buildApp({
      config,
      bot: { handleIncoming: hung } as unknown as StickerBotService,
      db,
    });

    const response = await postSigned(interrupted, payload);
    expect(response.statusCode).toBe(200);
    await vi.waitFor(() => expect(hung).toHaveBeenCalledOnce());
    await interrupted.close();

    const handleIncoming = vi.fn(async () => undefined);
    app = buildApp({ config, bot: { handleIncoming } as unknown as StickerBotService, db });
    await app.ready();
    await vi.waitFor(() => expect(handleIncoming).toHaveBeenCalledOnce());
    expect(handleIncoming).toHaveBeenCalledWith(expect.objectContaining({ id: 'wamid-restart', from: allowedSender }));

    await postSigned(app, payload);
    await app.drainMessageQueue();
    expect(handleIncoming).toHaveBeenCalledOnce();
  });
});

function webhookPayload(messageId: string, from = allowedSender): string {
  return JSON.stringify({
    entry: [{
      changes: [{
        value: {
          messages: [{ id: messageId, from, type: 'text', text: { body: 'hello' } }],
        },
      }],
    }],
  });
}

function postSigned(instance: ReturnType<typeof buildApp>, payload: string) {
  const signature = createHmac('sha256', appSecret).update(payload).digest('hex');
  return instance.inject({
    method: 'POST',
    url: '/webhook',
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': `sha256=${signature}` },
    payload,
  });
}
