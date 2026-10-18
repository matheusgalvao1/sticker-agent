import sharp from 'sharp';

const STICKER_DIMENSION = 512;
const MAX_STICKER_BYTES = 100_000;
const WEBP_QUALITIES = [90, 80, 70, 60, 50, 40, 30, 20];
const MAX_REFERENCE_DIMENSION = 1536;
const PIXEL_LIMIT = { limitInputPixels: 40_000_000 } as const;

export class AnimatedStickerError extends Error {
  constructor() {
    super('Animated stickers are not supported yet. Send a static sticker or a photo.');
    this.name = 'AnimatedStickerError';
  }
}

export interface ReferenceAsset {
  data: Buffer;
  kind: 'sticker' | 'image';
  mimeType: string;
}

export interface ModelReference {
  data: Buffer;
  mimeType: 'image/png' | 'image/jpeg';
}

export async function isAnimatedSticker(input: Buffer): Promise<boolean> {
  const metadata = await sharp(input, { ...PIXEL_LIMIT, animated: true }).metadata();
  return (metadata.pages ?? 1) > 1;
}

export async function normalizeSticker(input: Buffer): Promise<Buffer> {
  const metadata = await sharp(input, PIXEL_LIMIT).metadata();
  if (!metadata.width || !metadata.height) {
    throw new Error('The image has no readable dimensions.');
  }

  for (const quality of WEBP_QUALITIES) {
    const sticker = await sharp(input, PIXEL_LIMIT)
      .resize(STICKER_DIMENSION, STICKER_DIMENSION, {
        fit: 'contain',
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      })
      .webp({ quality, alphaQuality: 90, effort: 6 })
      .toBuffer();

    if (sticker.byteLength <= MAX_STICKER_BYTES) return sticker;
  }

  throw new Error('Could not compress the sticker below WhatsApp’s 100 KB static-sticker limit.');
}

/**
 * Converts a stored asset into an image the image model can read. Stickers become
 * PNG so their transparency survives; photos and PNG images are downscaled to keep
 * request sizes reasonable.
 */
export async function toModelReference(asset: ReferenceAsset): Promise<ModelReference> {
  if (asset.kind === 'sticker') {
    if (await isAnimatedSticker(asset.data)) throw new AnimatedStickerError();
    return {
      data: await sharp(asset.data, PIXEL_LIMIT).png().toBuffer(),
      mimeType: 'image/png',
    };
  }

  const resized = sharp(asset.data, PIXEL_LIMIT).rotate().resize({
    width: MAX_REFERENCE_DIMENSION,
    height: MAX_REFERENCE_DIMENSION,
    fit: 'inside',
    withoutEnlargement: true,
  });

  if (asset.mimeType === 'image/png') {
    return { data: await resized.png().toBuffer(), mimeType: 'image/png' };
  }
  return { data: await resized.jpeg({ quality: 90 }).toBuffer(), mimeType: 'image/jpeg' };
}

export const stickerConstraints = {
  dimension: STICKER_DIMENSION,
  maxBytes: MAX_STICKER_BYTES,
} as const;
