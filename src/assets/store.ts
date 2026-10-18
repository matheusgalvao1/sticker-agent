import type { Clock } from '../clock.js';

export type AssetKind = 'sticker' | 'image';
export type AssetOrigin = 'user' | 'generated';

export interface StoredAsset {
  id: string;
  kind: AssetKind;
  origin: AssetOrigin;
  mimeType: string;
  data: Buffer;
  createdAt: number;
}

export type NewAsset = Omit<StoredAsset, 'id' | 'createdAt'>;

interface SenderAssets {
  lastActiveAt: number;
  counter: number;
  assets: Map<string, StoredAsset>;
}

/**
 * Per-sender memory of the stickers and images in a conversation. Asset IDs are short
 * and stable (e.g. `sticker_1`, `image_2`) so the agent can refer to them in tool calls.
 */
export class AssetStore {
  private readonly senders = new Map<string, SenderAssets>();

  constructor(
    private readonly ttlMs: number,
    private readonly clock: Clock,
    private readonly maxPerSender = 30,
  ) {}

  add(sender: string, asset: NewAsset): StoredAsset {
    const state = this.touch(sender);
    state.counter += 1;
    const id = `${asset.kind}_${state.counter}`;
    const stored: StoredAsset = { ...asset, id, createdAt: this.clock.now() };
    state.assets.set(id, stored);

    while (state.assets.size > this.maxPerSender) {
      const oldest = state.assets.keys().next().value;
      if (oldest === undefined) break;
      state.assets.delete(oldest);
    }

    return stored;
  }

  get(sender: string, id: string): StoredAsset | undefined {
    return this.touch(sender).assets.get(id);
  }

  list(sender: string): StoredAsset[] {
    return [...this.touch(sender).assets.values()];
  }

  clear(sender: string): void {
    this.senders.delete(sender);
  }

  private touch(sender: string): SenderAssets {
    const now = this.clock.now();
    let state = this.senders.get(sender);
    if (!state || now - state.lastActiveAt > this.ttlMs) {
      state = { lastActiveAt: now, counter: 0, assets: new Map() };
      this.senders.set(sender, state);
    }
    state.lastActiveAt = now;
    return state;
  }
}
