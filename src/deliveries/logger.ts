import type { Clock } from '../clock.js';
import type { Db } from '../db/database.js';
import type { Messenger, MediaAsset, SendOutcome } from '../messaging.js';

/**
 * Wraps the WhatsApp client and records every outbound send in SQLite — success as
 * `sent` with the WhatsApp message id, failure as `error` with the reason. Both matter:
 * without them there is no way to audit what the bot told a user after the fact.
 */
export class LoggedMessenger implements Messenger {
  constructor(
    private readonly inner: Messenger,
    private readonly db: Db,
    private readonly clock: Clock,
  ) {}

  downloadMedia(mediaId: string): Promise<MediaAsset> {
    return this.inner.downloadMedia(mediaId);
  }

  async sendText(recipient: string, body: string): Promise<SendOutcome> {
    return await this.record(recipient, 'text', () => this.inner.sendText(recipient, body), (outcome) => ({
      body: body.slice(0, 200),
      wamid: outcome.wamid,
    }));
  }

  async sendSticker(recipient: string, stickerWebp: Buffer): Promise<SendOutcome> {
    return await this.record(recipient, 'sticker', () => this.inner.sendSticker(recipient, stickerWebp), (outcome) => ({
      bytes: stickerWebp.byteLength,
      wamid: outcome.wamid,
    }));
  }

  private async record(
    sender: string,
    kind: 'text' | 'sticker',
    send: () => Promise<SendOutcome>,
    detail: (outcome: SendOutcome) => { body?: string; wamid?: string | null; bytes?: number },
  ): Promise<SendOutcome> {
    try {
      const outcome = await send();
      this.insert(sender, kind, 'sent', detail(outcome), null);
      return outcome;
    } catch (error) {
      this.insert(sender, kind, 'error', {}, errorMessage(error));
      throw error;
    }
  }

  private insert(
    sender: string,
    kind: string,
    status: string,
    detail: { body?: string; wamid?: string | null; bytes?: number },
    error: string | null,
  ): void {
    // The database must never break messaging, so insert failures are swallowed.
    try {
      this.db.prepare(`
        INSERT INTO delivery_log (sender, kind, status, wamid, body, bytes, error, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(sender, kind, status, detail.wamid ?? null, detail.body ?? null, detail.bytes ?? null, error, this.clock.now());
    } catch {}
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300);
}
