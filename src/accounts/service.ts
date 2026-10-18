import { randomUUID } from 'node:crypto';
import type { Clock } from '../clock.js';
import type { Db } from '../db/database.js';

export interface User {
  id: string;
  whatsappId: string;
  status: string;
}

/**
 * Accounts are keyed by WhatsApp number. Meta verifies the number and the allowlist
 * decides who may use the bot, so no separate sign-up step is needed.
 */
export class AccountService {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
  ) {}

  findUser(whatsappId: string): User | undefined {
    return this.db.prepare(`
      SELECT id, whatsapp_id AS whatsappId, status FROM users WHERE whatsapp_id = ?
    `).get(whatsappId) as User | undefined;
  }

  getOrCreateUser(whatsappId: string): { user: User; created: boolean } {
    const existing = this.findUser(whatsappId);
    if (existing) return { user: existing, created: false };

    const user: User = { id: randomUUID(), whatsappId, status: 'active' };
    this.db.prepare(`
      INSERT INTO users (id, whatsapp_id, status, created_at) VALUES (?, ?, ?, ?)
    `).run(user.id, user.whatsappId, user.status, this.clock.now());
    return { user, created: true };
  }
}
