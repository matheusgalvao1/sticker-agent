import { describe, expect, it } from 'vitest';
import type { Messenger, SendOutcome } from '../../src/messaging.js';
import { LoggedMessenger } from '../../src/deliveries/logger.js';
import { openDatabase } from '../../src/db/database.js';

const clock = { now: () => 42_000 };

function fakeMessenger(failure?: (kind: 'text' | 'sticker') => Promise<never>) {
  const calls: Array<{ kind: 'text' | 'sticker'; to: string; body?: string; data?: Buffer }> = [];
  const messenger: Messenger = {
    async downloadMedia() {
      throw new Error('not used');
    },
    async sendText(to, body) {
      await failure?.('text');
      calls.push({ kind: 'text', to, body });
      return outcome('wamid.1');
    },
    async sendSticker(to, data) {
      await failure?.('sticker');
      calls.push({ kind: 'sticker', to, data });
      return outcome(null);
    },
  };
  function outcome(wamid: string | null): SendOutcome {
    return { wamid };
  }
  return { messenger, calls };
}

describe('LoggedMessenger', () => {
  it('records successful text and sticker sends with their WhatsApp ids', async () => {
    const { messenger } = fakeMessenger();
    const db = openDatabase(':memory:');
    const logged = new LoggedMessenger(messenger, db, clock);

    await logged.sendText('55550009999', 'Gerando seu sticker… 🎨');
    await logged.sendSticker('55550009999', Buffer.from([0, 1, 2, 3]));

    const rows = db.prepare(`SELECT sender, kind, status, wamid, body, bytes, error, created_at FROM delivery_log ORDER BY id`).all();
    expect(rows).toEqual([
      { sender: '55550009999', kind: 'text', status: 'sent', wamid: 'wamid.1', body: 'Gerando seu sticker… 🎨', bytes: null, error: null, created_at: 42_000 },
      { sender: '55550009999', kind: 'sticker', status: 'sent', wamid: null, body: null, bytes: 4, error: null, created_at: 42_000 },
    ]);
  });

  it('records the failure, keeps the error reason, and rethrows so callers can react', async () => {
    const { messenger } = fakeMessenger(async (kind) => {
      throw new Error(kind === 'sticker' ? 'Graph API is grumpy today' : 'unused');
    });
    const db = openDatabase(':memory:');
    const logged = new LoggedMessenger(messenger, db, clock);

    await expect(logged.sendSticker('55550009999', Buffer.alloc(3)))
      .rejects.toThrow('Graph API is grumpy today');

    const [row] = db.prepare(`SELECT kind, status, error FROM delivery_log`).all();
    expect(row).toMatchObject({ kind: 'sticker', status: 'error', error: 'Graph API is grumpy today' });
  });
});
