import { describe, expect, it } from 'vitest';
import { extractIncomingMessages } from '../../src/whatsapp/types.js';

describe('extractIncomingMessages', () => {
  it('extracts text, image, and sticker messages from webhook changes', () => {
    const messages = extractIncomingMessages({
      object: 'whatsapp_business_account',
      entry: [{
        id: 'waba-id',
        changes: [{
          field: 'messages',
          value: {
            messaging_product: 'whatsapp',
            messages: [
              { id: 'wamid-text', from: '15551234567', type: 'text', text: { body: 'hello' } },
              { id: 'wamid-image', from: '15551234567', type: 'image', image: { id: 'media-1', caption: 'make me smile' } },
              { id: 'wamid-sticker', from: '15551234567', type: 'sticker', sticker: { id: 'media-2', mime_type: 'image/webp' } },
            ],
          },
        }],
      }],
    });

    expect(messages.map((message) => message.type)).toEqual(['text', 'image', 'sticker']);
    expect(messages[1]?.image?.caption).toBe('make me smile');
  });
});
