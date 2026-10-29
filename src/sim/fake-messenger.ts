import type { Messenger, MediaAsset, SendOutcome } from '../messaging.js';

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

  async sendText(to: string, body: string): Promise<SendOutcome> {
    await this.record({ type: 'text', to, body });
    return { wamid: `fake-${this.outbound.length}` };
  }

  async sendSticker(to: string, stickerWebp: Buffer): Promise<SendOutcome> {
    await this.record({ type: 'sticker', to, data: stickerWebp });
    return { wamid: `fake-${this.outbound.length}` };
  }

  private async record(message: OutboundMessage): Promise<void> {
    this.outbound.push(message);
    await this.onOutbound?.(message);
  }
}
