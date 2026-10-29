import type { FastifyBaseLogger } from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { PendingInputs } from '../../src/jobs/pending-inputs.js';
import { MessageScheduler } from '../../src/jobs/message-scheduler.js';
import { openDatabase } from '../../src/db/database.js';
import type { IncomingWhatsAppMessage } from '../../src/whatsapp/types.js';

const sender = '15551234567';

function schedulerOf(windowMs: number) {
  const ingestMessage = vi.fn(async (message: IncomingWhatsAppMessage) => ({
    text: message.text?.body ?? '',
    newAssetIds: [],
    skip: false,
  }));
  const runBatch = vi.fn(async () => undefined);
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as FastifyBaseLogger;
  const scheduler = new MessageScheduler(
    openDatabase(':memory:'),
    { ingestMessage, runBatch },
    logger,
    new PendingInputs(),
    windowMs,
  );
  return { scheduler, ingestMessage, runBatch };
}

function textMessage(id: string, body: string): IncomingWhatsAppMessage {
  return { id, from: sender, type: 'text', text: { body } };
}

describe('MessageScheduler', () => {
  it('merges a quick burst of messages into one batched turn', async () => {
    const { scheduler, runBatch } = schedulerOf(50);

    const first = scheduler.accept(textMessage('wamid.1', 'faz um sticker'));
    expect(first).toBe(true);
    scheduler.accept(textMessage('wamid.2', 'azul'));

    await scheduler.drain();
    expect(runBatch).toHaveBeenCalledTimes(1);
    expect(runBatch).toHaveBeenCalledWith(sender, ['faz um sticker', 'azul'], []);
  });

  it('runs later messages as their own turn after an in-flight one', async () => {
    const { scheduler, runBatch } = schedulerOf(0);

    scheduler.accept(textMessage('wamid.1', 'um gato'));
    scheduler.accept(textMessage('wamid.2', 'faz outro de chapéu'));

    await scheduler.drain();
    expect(runBatch).toHaveBeenCalledTimes(2);
    expect(runBatch.mock.calls[0]).toEqual([sender, ['um gato'], []]);
    expect(runBatch.mock.calls[1]).toEqual([sender, ['faz outro de chapéu'], []]);
  });
});
