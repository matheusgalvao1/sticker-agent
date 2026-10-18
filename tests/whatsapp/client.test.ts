import { describe, expect, it, vi } from 'vitest';
import { WhatsAppCloudClient } from '../../src/whatsapp/client.js';

const config = {
  accessToken: 'token',
  phoneNumberId: 'phone-1',
  graphApiVersion: 'v25.0',
  maxInputImageBytes: 1_000_000,
  graphBaseUrl: 'https://graph.test',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('WhatsAppCloudClient', () => {
  it('uploads a sticker and then sends it by media ID', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json({ id: 'media-42' }))
      .mockResolvedValueOnce(json({ messages: [{ id: 'wamid.out' }] }));
    const client = new WhatsAppCloudClient(config, fetcher);

    await client.sendSticker('15551234567', Buffer.from('webp-bytes'));

    const [uploadUrl, uploadInit] = fetcher.mock.calls[0]!;
    expect(uploadUrl).toBe('https://graph.test/v25.0/phone-1/media');
    expect(uploadInit?.method).toBe('POST');
    expect((uploadInit?.body as FormData).get('type')).toBe('image/webp');

    const [sendUrl, sendInit] = fetcher.mock.calls[1]!;
    expect(sendUrl).toBe('https://graph.test/v25.0/phone-1/messages');
    expect(JSON.parse(String(sendInit?.body))).toMatchObject({
      messaging_product: 'whatsapp',
      to: '15551234567',
      type: 'sticker',
      sticker: { id: 'media-42' },
    });
  });

  it('refuses to upload a sticker over the 100 KB limit', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const client = new WhatsAppCloudClient(config, fetcher);

    await expect(client.sendSticker('15551234567', Buffer.alloc(100_001))).rejects.toThrow('100 KB');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('downloads an incoming image using the media metadata URL', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json({ url: 'https://cdn.test/media-1', mime_type: 'image/jpeg', file_size: 4 }))
      .mockResolvedValueOnce(new Response(Buffer.from('jpeg'), { headers: { 'content-type': 'image/jpeg' } }));
    const client = new WhatsAppCloudClient(config, fetcher);

    const media = await client.downloadMedia('media-1');

    expect(media.data.toString()).toBe('jpeg');
    expect(media.mimeType).toBe('image/jpeg');
    expect(fetcher.mock.calls[0]?.[0]).toBe('https://graph.test/v25.0/media-1');
  });

  it('surfaces Graph API error messages', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(
      json({ error: { message: 'Invalid OAuth access token.' } }, 401),
    );
    const client = new WhatsAppCloudClient(config, fetcher);

    await expect(client.sendText('15551234567', 'oi')).rejects.toThrow('Invalid OAuth access token.');
  });
});
