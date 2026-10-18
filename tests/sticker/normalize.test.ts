import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import {
  AnimatedStickerError,
  isAnimatedSticker,
  normalizeSticker,
  stickerConstraints,
  toModelReference,
} from '../../src/sticker/normalize.js';

async function staticSticker(): Promise<Buffer> {
  return sharp(Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512"><circle cx="256" cy="256" r="200" fill="#e53935"/></svg>',
  )).webp().toBuffer();
}

async function animatedSticker(): Promise<Buffer> {
  const frame = (color: { r: number; g: number; b: number; alpha: number }) =>
    sharp({ create: { width: 64, height: 64, channels: 4, background: color } }).png().toBuffer();
  const frames = await Promise.all([
    frame({ r: 255, g: 0, b: 0, alpha: 1 }),
    frame({ r: 0, g: 0, b: 255, alpha: 1 }),
  ]);
  return sharp(frames, { join: { animated: true } }).webp().toBuffer();
}

describe('normalizeSticker', () => {
  it('returns a 512x512 WebP within the WhatsApp static sticker size limit', async () => {
    const input = await sharp({
      create: {
        width: 320,
        height: 240,
        channels: 4,
        background: { r: 240, g: 40, b: 40, alpha: 0.8 },
      },
    }).png().toBuffer();

    const output = await normalizeSticker(input);
    const metadata = await sharp(output).metadata();

    expect(metadata.format).toBe('webp');
    expect(metadata.width).toBe(stickerConstraints.dimension);
    expect(metadata.height).toBe(stickerConstraints.dimension);
    expect(output.byteLength).toBeLessThanOrEqual(stickerConstraints.maxBytes);
  });

  it('rejects input that is not an image', async () => {
    await expect(normalizeSticker(Buffer.from('not an image'))).rejects.toThrow();
  });
});

describe('isAnimatedSticker', () => {
  it('detects animated WebP and ignores static stickers', async () => {
    expect(await isAnimatedSticker(await staticSticker())).toBe(false);
    expect(await isAnimatedSticker(await animatedSticker())).toBe(true);
  });
});

describe('toModelReference', () => {
  it('passes a static sticker to the image model as PNG with its transparency intact', async () => {
    const reference = await toModelReference({
      data: await staticSticker(),
      kind: 'sticker',
      mimeType: 'image/webp',
    });

    const metadata = await sharp(reference.data).metadata();
    expect(reference.mimeType).toBe('image/png');
    expect(metadata.format).toBe('png');
    expect(metadata.hasAlpha).toBe(true);
  });

  it('refuses animated stickers as references', async () => {
    await expect(toModelReference({
      data: await animatedSticker(),
      kind: 'sticker',
      mimeType: 'image/webp',
    })).rejects.toBeInstanceOf(AnimatedStickerError);
  });

  it('downscales large photos to JPEG', async () => {
    const photo = await sharp({
      create: { width: 4000, height: 3000, channels: 3, background: { r: 120, g: 90, b: 60 } },
    }).jpeg().toBuffer();

    const reference = await toModelReference({ data: photo, kind: 'image', mimeType: 'image/jpeg' });
    const metadata = await sharp(reference.data).metadata();

    expect(reference.mimeType).toBe('image/jpeg');
    expect(Math.max(metadata.width ?? 0, metadata.height ?? 0)).toBe(1536);
  });

  it('keeps transparent generated images as PNG', async () => {
    const generated = await sharp({
      create: { width: 1024, height: 1024, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    }).png().toBuffer();

    const reference = await toModelReference({ data: generated, kind: 'image', mimeType: 'image/png' });
    expect(reference.mimeType).toBe('image/png');
    expect((await sharp(reference.data).metadata()).hasAlpha).toBe(true);
  });
});
