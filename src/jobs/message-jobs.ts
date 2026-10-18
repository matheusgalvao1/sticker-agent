import type { FastifyBaseLogger } from 'fastify';
import type { StickerBotService } from '../bot/sticker-bot.js';
import { systemClock, type Clock } from '../clock.js';
import type { Db } from '../db/database.js';
import type { IncomingWhatsAppMessage } from '../whatsapp/types.js';

const KEEP_FINISHED_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Incoming messages are saved to SQLite before the webhook is acknowledged. If the machine
 * stops or restarts mid-reply, unfinished jobs run again when the app starts.
 */
export class MessageJobs {
  private readonly tails = new Map<string, Promise<void>>();

  constructor(
    private readonly db: Db,
    private readonly bot: Pick<StickerBotService, 'handleIncoming'>,
    private readonly log: FastifyBaseLogger,
    private readonly clock: Clock = systemClock,
  ) {}

  /** Returns false when Meta has already delivered this message. */
  accept(message: IncomingWhatsAppMessage): boolean {
    const now = this.clock.now();
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO message_jobs (message_id, payload, status, created_at, updated_at)
      VALUES (?, ?, 'pending', ?, ?)
    `).run(message.id, JSON.stringify(message), now, now);
    if (result.changes === 0) return false;

    this.start(Number(result.lastInsertRowid), message);
    return true;
  }

  /** Runs the jobs an earlier process left unfinished, and prunes finished jobs older than a week. */
  resume(): void {
    this.db.prepare(`
      DELETE FROM message_jobs WHERE status IN ('done', 'failed') AND updated_at < ?
    `).run(this.clock.now() - KEEP_FINISHED_MS);
    this.db.prepare(`UPDATE message_jobs SET status = 'pending' WHERE status = 'processing'`).run();

    const pending = this.db.prepare(`
      SELECT id, payload FROM message_jobs WHERE status = 'pending' ORDER BY id
    `).all() as Array<{ id: number; payload: string }>;
    for (const job of pending) {
      this.start(job.id, JSON.parse(job.payload) as IncomingWhatsAppMessage);
    }
  }

  /** Resolves once every started job has finished. */
  async drain(): Promise<void> {
    while (this.tails.size > 0) {
      await Promise.allSettled([...this.tails.values()]);
    }
  }

  private start(id: number, message: IncomingWhatsAppMessage): void {
    const sender = message.from;
    const previous = this.tails.get(sender) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(() => this.run(id, message));
    this.tails.set(sender, next);

    void next.finally(() => {
      if (this.tails.get(sender) === next) this.tails.delete(sender);
    }).catch(() => undefined);
  }

  private async run(id: number, message: IncomingWhatsAppMessage): Promise<void> {
    this.setStatus(id, 'processing', null);
    try {
      await this.bot.handleIncoming(message);
      this.setStatus(id, 'done', null);
    } catch (error) {
      this.log.error({ err: error, jobId: id, messageId: message.id }, 'Failed to process WhatsApp message.');
      this.setStatus(id, 'failed', error instanceof Error ? error.message : String(error));
    }
  }

  private setStatus(id: number, status: 'processing' | 'done' | 'failed', lastError: string | null): void {
    this.db.prepare(`
      UPDATE message_jobs SET status = ?, last_error = ?, updated_at = ? WHERE id = ?
    `).run(status, lastError, this.clock.now(), id);
  }
}
