import { describe, expect, it } from 'vitest';
import { AssetStore } from '../../src/assets/store.js';

const data = Buffer.from('bytes');

describe('AssetStore', () => {
  it('assigns readable IDs and keeps each sender’s assets separate', () => {
    const store = new AssetStore(60_000, { now: () => 0 });

    const sticker = store.add('alice', { kind: 'sticker', origin: 'user', mimeType: 'image/webp', data });
    const image = store.add('alice', { kind: 'image', origin: 'generated', mimeType: 'image/png', data });
    store.add('bob', { kind: 'image', origin: 'user', mimeType: 'image/jpeg', data });

    expect(sticker.id).toBe('sticker_1');
    expect(image.id).toBe('image_2');
    expect(store.list('alice').map((asset) => asset.id)).toEqual(['sticker_1', 'image_2']);
    expect(store.get('bob', 'sticker_1')).toBeUndefined();
  });

  it('forgets a sender after the memory TTL passes without activity', () => {
    let now = 1_000;
    const store = new AssetStore(500, { now: () => now });
    store.add('alice', { kind: 'sticker', origin: 'user', mimeType: 'image/webp', data });

    now += 400;
    expect(store.get('alice', 'sticker_1')).toBeDefined();

    now += 501;
    expect(store.list('alice')).toEqual([]);
  });

  it('evicts the oldest assets when a sender exceeds the limit', () => {
    const store = new AssetStore(60_000, { now: () => 0 }, 2);
    store.add('alice', { kind: 'image', origin: 'user', mimeType: 'image/jpeg', data });
    store.add('alice', { kind: 'image', origin: 'user', mimeType: 'image/jpeg', data });
    store.add('alice', { kind: 'image', origin: 'user', mimeType: 'image/jpeg', data });

    expect(store.list('alice').map((asset) => asset.id)).toEqual(['image_2', 'image_3']);
  });
});
