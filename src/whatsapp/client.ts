import type { Messenger, MediaAsset } from '../messaging.js';

export interface WhatsAppClientConfig {
  accessToken: string;
  phoneNumberId: string;
  graphApiVersion: string;
  maxInputImageBytes: number;
  graphBaseUrl?: string | undefined;
}

interface GraphMediaMetadata {
  url?: string;
  mime_type?: string;
  file_size?: number;
}

interface GraphMediaUploadResponse {
  id?: string;
}

export class WhatsAppCloudClient implements Messenger {
  private readonly graphBaseUrl: string;

  constructor(
    private readonly config: WhatsAppClientConfig,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    this.graphBaseUrl = `${config.graphBaseUrl ?? 'https://graph.facebook.com'}/${config.graphApiVersion}`;
  }

  async downloadMedia(mediaId: string): Promise<MediaAsset> {
    const metadataResponse = await this.fetcher(`${this.graphBaseUrl}/${encodeURIComponent(mediaId)}`, {
      headers: { Authorization: `Bearer ${this.config.accessToken}` },
      signal: AbortSignal.timeout(30_000),
    });

    const metadata = await readJson<GraphMediaMetadata>(metadataResponse, 'WhatsApp media metadata');
    if (!metadata.url) throw new Error('WhatsApp did not return a media download URL.');
    if (metadata.file_size && metadata.file_size > this.config.maxInputImageBytes) {
      throw new Error(`Incoming media exceeds the ${this.config.maxInputImageBytes}-byte limit.`);
    }

    const mediaResponse = await this.fetcher(metadata.url, {
      headers: { Authorization: `Bearer ${this.config.accessToken}` },
      signal: AbortSignal.timeout(30_000),
    });

    if (!mediaResponse.ok) {
      throw new Error(`WhatsApp media download failed with HTTP ${mediaResponse.status}.`);
    }

    const contentLength = Number(mediaResponse.headers.get('content-length'));
    if (Number.isFinite(contentLength) && contentLength > this.config.maxInputImageBytes) {
      throw new Error(`Incoming media exceeds the ${this.config.maxInputImageBytes}-byte limit.`);
    }

    const data = Buffer.from(await mediaResponse.arrayBuffer());
    if (data.byteLength > this.config.maxInputImageBytes) {
      throw new Error(`Incoming media exceeds the ${this.config.maxInputImageBytes}-byte limit.`);
    }

    const responseMimeType = mediaResponse.headers.get('content-type')?.split(';')[0]?.trim();
    const metadataMimeType = metadata.mime_type?.split(';')[0]?.trim();
    const mimeType = responseMimeType?.startsWith('image/')
      ? responseMimeType
      : metadataMimeType ?? responseMimeType ?? 'application/octet-stream';

    if (!mimeType?.startsWith('image/')) {
      throw new Error(`Expected an image from WhatsApp; received ${mimeType ?? 'unknown media type'}.`);
    }

    return {
      data,
      mimeType,
      filename: `${mediaId}.${extensionForMimeType(mimeType)}`,
    };
  }

  async sendText(recipient: string, body: string): Promise<void> {
    await this.postMessage({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: recipient,
      type: 'text',
      text: { body: body.slice(0, 4096), preview_url: false },
    });
  }

  async sendSticker(recipient: string, stickerWebp: Buffer): Promise<void> {
    if (stickerWebp.byteLength > 100_000) {
      throw new Error('Sticker WebP must be no larger than 100 KB.');
    }

    const form = new FormData();
    form.set('messaging_product', 'whatsapp');
    form.set('type', 'image/webp');
    form.set('file', new Blob([new Uint8Array(stickerWebp)], { type: 'image/webp' }), 'sticker.webp');

    const uploadResponse = await this.fetcher(`${this.graphBaseUrl}/${this.config.phoneNumberId}/media`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.config.accessToken}` },
      body: form,
      signal: AbortSignal.timeout(30_000),
    });
    const upload = await readJson<GraphMediaUploadResponse>(uploadResponse, 'WhatsApp sticker upload');
    if (!upload.id) throw new Error('WhatsApp did not return an uploaded media ID.');

    await this.postMessage({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: recipient,
      type: 'sticker',
      sticker: { id: upload.id },
    });
  }

  private async postMessage(payload: Record<string, unknown>): Promise<void> {
    const response = await this.fetcher(`${this.graphBaseUrl}/${this.config.phoneNumberId}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.config.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30_000),
    });

    await readJson<Record<string, unknown>>(response, 'WhatsApp send message');
  }
}

async function readJson<T>(response: Response, operation: string): Promise<T> {
  const text = await response.text();
  let parsed: unknown;

  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`${operation} returned invalid JSON (HTTP ${response.status}).`);
  }

  if (!response.ok) {
    const message = getGraphErrorMessage(parsed);
    throw new Error(`${operation} failed (HTTP ${response.status}): ${message}`);
  }

  return parsed as T;
}

function getGraphErrorMessage(payload: unknown): string {
  if (typeof payload !== 'object' || payload === null || !('error' in payload)) {
    return 'the upstream service returned an error';
  }

  const error = payload.error;
  if (typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string') {
    return error.message.slice(0, 300);
  }

  return 'the upstream service returned an error';
}

function extensionForMimeType(mimeType: string): string {
  switch (mimeType) {
    case 'image/webp': return 'webp';
    case 'image/png': return 'png';
    case 'image/jpeg': return 'jpg';
    case 'image/gif': return 'gif';
    default: return 'img';
  }
}
