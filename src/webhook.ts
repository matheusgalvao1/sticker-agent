import { createHmac, timingSafeEqual } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyRequest, type FastifyServerOptions } from 'fastify';
import type { AppConfig } from './config.js';
import { normalizePhoneNumber } from './config.js';
import type { StickerBotService } from './bot/sticker-bot.js';
import type { Db } from './db/database.js';
import { PendingInputs } from './jobs/pending-inputs.js';
import { MessageScheduler } from './jobs/message-scheduler.js';
import { extractIncomingMessages } from './whatsapp/types.js';

declare module 'fastify' {
  interface FastifyRequest {
    rawBody: Buffer;
  }
  interface FastifyInstance {
    /** Resolves once every queued WhatsApp message has finished processing. */
    drainMessageQueue(): Promise<void>;
  }
}

export interface WebhookAppDependencies {
  config: AppConfig;
  bot: StickerBotService;
  db: Db;
  pendingInputs?: PendingInputs;
}

export function buildApp(dependencies: WebhookAppDependencies): FastifyInstance {
  const app = Fastify({
    logger: loggerOptions(dependencies.config.environment),
    bodyLimit: 1_000_000,
  });

  app.removeContentTypeParser('application/json');
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' },
    (request, body, done) => {
      const rawBody = Buffer.isBuffer(body) ? body : Buffer.from(body);
      request.rawBody = rawBody;
      try {
        done(null, JSON.parse(rawBody.toString('utf8')) as unknown);
      } catch (error) {
        done(error instanceof Error ? error : new Error('Malformed JSON body.'));
      }
    },
  );
  const jobs = new MessageScheduler(
    dependencies.db,
    dependencies.bot,
    app.log,
    dependencies.pendingInputs ?? new PendingInputs(),
    dependencies.config.batchWindowMs,
  );

  app.decorate('drainMessageQueue', () => jobs.drain());
  app.addHook('onReady', async () => {
    await jobs.resume();
  });

  app.get('/health', async () => ({ ok: true }));

  app.get('/webhook', async (request, reply) => {
    const query = request.query as Record<string, string | undefined>;
    const mode = query['hub.mode'];
    const token = query['hub.verify_token'];
    const challenge = query['hub.challenge'];

    if (mode === 'subscribe' && token === dependencies.config.whatsapp.verifyToken && challenge) {
      return reply.type('text/plain').send(challenge);
    }

    return reply.code(403).send({ error: 'Webhook verification failed.' });
  });

  app.post('/webhook', async (request, reply) => {
    if (dependencies.config.whatsapp.appSecret && !isValidMetaSignature(request, dependencies.config.whatsapp.appSecret)) {
      return reply.code(401).send({ error: 'Invalid webhook signature.' });
    }

    let messages;
    try {
      messages = extractIncomingMessages(request.body);
    } catch (error) {
      request.log.warn({ error }, 'Ignoring invalid WhatsApp webhook payload.');
      return reply.code(400).send({ error: 'Invalid webhook payload.' });
    }

    const statuses = summarizeStatuses(request.body);
    if (statuses.length > 0) request.log.info({ statuses }, 'Received WhatsApp delivery status.');

    request.log.info({
      fields: extractChangeFields(request.body),
      messageTypes: messages.map((message) => message.type),
      senders: messages.map((message) => maskNumber(message.from)),
    }, 'Received WhatsApp webhook.');

    for (const message of messages) {
      const sender = normalizePhoneNumber(message.from);
      const allowed = dependencies.config.whatsapp.allowedNumbers;
      if (allowed.size > 0 && !allowed.has(sender)) {
        request.log.warn({ sender: maskNumber(message.from) }, 'Ignored a message from a number that is not allowed.');
        continue;
      }
      jobs.accept({ ...message, from: sender });
    }

    // Jobs are saved before the acknowledgement, so a restart resumes them instead of losing them.
    return reply.code(200).send({ received: true });
  });

  return app;
}

function loggerOptions(environment: AppConfig['environment']): NonNullable<FastifyServerOptions['logger']> {
  if (environment === 'test') return false;
  return {
    serializers: {
      // Query strings can carry the webhook verify token, so keep only the path.
      req: (request: FastifyRequest) => ({
        method: request.method,
        url: (request.url ?? '').split('?')[0] ?? '',
        host: request.headers.host ?? '',
      }),
    },
  };
}

interface StatusUpdate {
  status?: string;
  recipient_id?: string;
  errors?: Array<{ code?: number; title?: string }>;
}

/** Delivery receipts for messages the bot sent: status, masked recipient, and any Meta error codes. */
function summarizeStatuses(body: unknown): Array<{ status: string; recipient: string; errors: string[] }> {
  const entries = (body as { entry?: Array<{ changes?: Array<{ value?: { statuses?: StatusUpdate[] } }> }> } | null)?.entry ?? [];
  const updates = entries.flatMap((entry) => (entry.changes ?? []).flatMap((change) => change.value?.statuses ?? []));
  return updates.map((update) => ({
    status: update.status ?? 'unknown',
    recipient: maskNumber(update.recipient_id ?? ''),
    errors: (update.errors ?? []).map((error) => `${error.code ?? ''} ${error.title ?? ''}`.trim()),
  }));
}

function maskNumber(value: string): string {
  return value.length > 4 ? `…${value.slice(-4)}` : '…';
}

function extractChangeFields(body: unknown): string[] {
  if (typeof body !== 'object' || body === null || !('entry' in body) || !Array.isArray(body.entry)) return [];
  return body.entry.flatMap((entry: { changes?: Array<{ field?: string }> }) =>
    (entry.changes ?? []).map((change) => change.field ?? 'unknown'),
  );
}

export function isValidMetaSignature(
  request: Pick<FastifyRequest, 'headers' | 'rawBody'>,
  appSecret: string,
): boolean {
  const signatureHeader = request.headers['x-hub-signature-256'];
  if (typeof signatureHeader !== 'string' || !signatureHeader.startsWith('sha256=')) return false;

  const provided = Buffer.from(signatureHeader.slice('sha256='.length), 'hex');
  if (!appSecret || provided.byteLength !== 32) return false;

  const expected = createHmac('sha256', appSecret).update(request.rawBody).digest();
  return timingSafeEqual(expected, provided);
}
