import type { Messenger, MediaAsset } from '../messaging.js';

export type OutboundMessage =
  | { type: 'text'; to: string; body: string }
  | { type: 'sticker'; to: string; data: Buffer };

/** An in-memory WhatsApp stand-in that records what the bot sends. */
export class FakeMessenger implements Messenger {
  readonly media = new Map<string, MediaAsset>();
  readonly outbound: OutboundMessage[] = [];

  constructor(private readonly onOutbound?: (message: OutboundMessage) => void | Promise<void>) {}

  async downloadMedia(mediaId: string): Promise<MediaAsset> {
    const asset = this.media.get(mediaId);
    if (!asset) throw new Error(`Unknown media ID ${mediaId}.`);
    return asset;
  }

  async sendText(to: string, body: string): Promise<void> {
    await this.record({ type: 'text', to, body });
  }

  async sendSticker(to: string, stickerWebp: Buffer): Promise<void> {
    await this.record({ type: 'sticker', to, data: stickerWebp });
  }

  private async record(message: OutboundMessage): Promise<void> {
    this.outbound.push(message);
    await this.onOutbound?.(message);
  }
}
