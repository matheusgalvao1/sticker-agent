import type { FastifyBaseLogger } from 'fastify';
import { systemClock, type Clock } from '../clock.js';
import type { Db } from '../db/database.js';
import type { IncomingWhatsAppMessage } from '../whatsapp/types.js';
import { PendingInputs, type PendingEntry } from './pending-inputs.js';

export interface SchedulerBot {
  ingestMessage(message: IncomingWhatsAppMessage): Promise<{ text: string; newAssetIds: string[]; skip: boolean }>;
  runBatch(sender: string, texts: string[], newAssetIds: string[]): Promise<void>;
}

const KEEP_FINISHED_MS = 7 * 24 * 60 * 60 * 1000;
const DRAIN_POLL_MS = 10;

/**
 * Saves each message, then runs one agent turn per burst of messages instead of per message.
 * A short debounce window lets a text-plus-photo pair arrive together. Messages that arrive
 * while a turn runs join the pending buffer, which the agent reads at tool boundaries.
 */
export class MessageScheduler {
  private readonly running = new Set<string>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly arriving = new Set<number>();

  constructor(
    private readonly db: Db,
    private readonly bot: SchedulerBot,
    private readonly log: FastifyBaseLogger,
    private readonly inputs: PendingInputs,
    private readonly windowMs: number,
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

    const jobId = Number(result.lastInsertRowid);
    this.arriving.add(jobId);
    void this.arrive(jobId, message)
      .catch((error) => {
        this.log.error({ err: error, messageId: message.id }, 'Failed to ingest WhatsApp message.');
        this.mark([jobId], 'failed', errorMessage(error));
      })
      .finally(() => this.arriving.delete(jobId));
    return true;
  }

  /** Re-ingests unfinished jobs and runs one batch per sender, without an extra debounce wait. */
  async resume(): Promise<void> {
    this.db.prepare(`
      DELETE FROM message_jobs WHERE status IN ('done', 'failed') AND updated_at < ?
    `).run(this.clock.now() - KEEP_FINISHED_MS);
    this.db.prepare(`UPDATE message_jobs SET status = 'pending' WHERE status = 'processing'`).run();

    const rows = this.db.prepare(`
      SELECT id, payload FROM message_jobs WHERE status = 'pending' ORDER BY id
    `).all() as Array<{ id: number; payload: string }>;

    const bySender = new Map<string, Array<{ id: number; message: IncomingWhatsAppMessage }>>();
    for (const row of rows) {
      const message = JSON.parse(row.payload) as IncomingWhatsAppMessage;
      const group = bySender.get(message.from) ?? [];
      group.push({ id: row.id, message });
      bySender.set(message.from, group);
    }

    await Promise.all([...bySender.values()].map(async (group) => {
      for (const job of group) {
        try {
          const ingested = await this.bot.ingestMessage(job.message);
          if (ingested.skip) {
            this.mark([job.id], 'done', null);
            continue;
          }
          this.inputs.add(job.message.from, {
            jobId: job.id,
            text: ingested.text,
            assetIds: ingested.newAssetIds,
          });
        } catch (error) {
          this.mark([job.id], 'failed', errorMessage(error));
        }
      }
      const first = group[0];
      if (first) await this.processBatch(first.message.from);
    }));
  }

  /** Resolves once no message is being ingested, no turn is running, nothing is waiting, and no debounce timer is set. */
  async drain(): Promise<void> {
    while (this.arriving.size > 0 || this.running.size > 0 || this.inputs.hasAny() || this.timers.size > 0) {
      await new Promise((resolve) => setTimeout(resolve, DRAIN_POLL_MS));
    }
  }

  private async arrive(jobId: number, message: IncomingWhatsAppMessage): Promise<void> {
    const sender = message.from;
    const ingested = await this.bot.ingestMessage(message);
    if (ingested.skip) {
      this.mark([jobId], 'done', null);
      return;
    }

    this.inputs.add(sender, { jobId, text: ingested.text, assetIds: ingested.newAssetIds });
    if (this.running.has(sender)) return;
    if (this.windowMs === 0) {
      void this.processBatch(sender);
      return;
    }
    this.resetTimer(sender);
  }

  private resetTimer(sender: string): void {
    const previous = this.timers.get(sender);
    if (previous) clearTimeout(previous);
    const timer = setTimeout(() => {
      this.timers.delete(sender);
      void this.processBatch(sender);
    }, this.windowMs);
    timer.unref();
    this.timers.set(sender, timer);
  }

  private async processBatch(sender: string): Promise<void> {
    if (this.running.has(sender) || !this.inputs.hasPending(sender)) return;
    this.running.add(sender);
    this.inputs.take(sender);

    try {
      const batch = this.inputs.peekInFlight(sender);
      await this.bot.runBatch(sender, texts(batch), assets(batch));
      this.mark(this.inputs.finish(sender).map((entry) => entry.jobId), 'done', null);
    } catch (error) {
      this.log.error({ err: error, sender: maskNumber(sender) }, 'Failed to process WhatsApp message batch.');
      this.mark(this.inputs.finish(sender).map((entry) => entry.jobId), 'failed', errorMessage(error));
    } finally {
      this.running.delete(sender);
      if (this.inputs.hasPending(sender)) void this.processBatch(sender);
    }
  }

  private mark(jobIds: number[], status: 'done' | 'failed', lastError: string | null): void {
    if (jobIds.length === 0) return;
    const placeholders = jobIds.map(() => '?').join(', ');
    this.db.prepare(`
      UPDATE message_jobs SET status = ?, last_error = ?, updated_at = ? WHERE id IN (${placeholders})
    `).run(status, lastError, this.clock.now(), ...jobIds);
  }
}

function texts(entries: PendingEntry[]): string[] {
  return entries.map((entry) => entry.text).filter((text) => text.length > 0);
}

function assets(entries: PendingEntry[]): string[] {
  return entries.flatMap((entry) => entry.assetIds);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function maskNumber(value: string): string {
  return value.length > 4 ? `…${value.slice(-4)}` : '…';
}
