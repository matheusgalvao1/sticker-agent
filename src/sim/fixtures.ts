import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import sharp from 'sharp';
import type { MediaAsset } from '../messaging.js';

export const SAMPLE_COLORS = {
  red: '#e53935',
  blue: '#1e88e5',
  green: '#43a047',
  orange: '#fb8c00',
  purple: '#8e24aa',
  yellow: '#fdd835',
  gray: '#757575',
} as const;

export type SampleColor = keyof typeof SAMPLE_COLORS;

const MIME_BY_EXTENSION: Record<string, string> = {
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
};

/**
 * Resolves a media spec for the harness and evals. Accepts `sticker:<color>`,
 * `photo:<color>`, or a path to a local image file.
 */
export async function loadMediaSpec(spec: string): Promise<MediaAsset> {
  const [kind, color] = spec.split(':');
  if (kind === 'sticker' || kind === 'photo') {
    return sampleMedia(kind, parseColor(color));
  }

  const mimeType = MIME_BY_EXTENSION[extname(spec).toLowerCase()];
  if (!mimeType) throw new Error(`Unsupported media file type: ${spec}`);
  return {
    data: await readFile(spec),
    mimeType,
    filename: spec.split('/').at(-1) ?? spec,
  };
}

async function sampleMedia(kind: 'sticker' | 'photo', color: SampleColor): Promise<MediaAsset> {
  if (kind === 'sticker') {
    return {
      data: await sharp(Buffer.from(stickerSvg(SAMPLE_COLORS[color]))).webp().toBuffer(),
      mimeType: 'image/webp',
      filename: `sample-sticker-${color}.webp`,
    };
  }

  return {
    data: await sharp(Buffer.from(photoSvg(SAMPLE_COLORS[color]))).jpeg({ quality: 90 }).toBuffer(),
    mimeType: 'image/jpeg',
    filename: `sample-photo-${color}.jpg`,
  };
}

function parseColor(value: string | undefined): SampleColor {
  if (value && value in SAMPLE_COLORS) return value as SampleColor;
  throw new Error(`Unknown sample color "${value ?? ''}". Use one of: ${Object.keys(SAMPLE_COLORS).join(', ')}.`);
}

function stickerSvg(fill: string): string {
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512">',
    `<circle cx="256" cy="256" r="200" fill="${fill}" stroke="#ffffff" stroke-width="24"/>`,
    '<circle cx="190" cy="220" r="26" fill="#222222"/>',
    '<circle cx="322" cy="220" r="26" fill="#222222"/>',
    '<path d="M160 320 Q256 400 352 320" stroke="#222222" stroke-width="18" fill="none" stroke-linecap="round"/>',
    '</svg>',
  ].join('');
}

function photoSvg(background: string): string {
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="900">',
    `<rect width="1200" height="900" fill="${background}"/>`,
    '<circle cx="600" cy="400" r="200" fill="#e0ac69"/>',
    '<rect x="380" y="620" width="440" height="280" rx="120" fill="#2b2b2b"/>',
    '</svg>',
  ].join('');
}
