import type { Clock } from '../clock.js';
import type { Db } from '../db/database.js';

/** Caps image generations per sender per UTC day. Counts are stored in SQLite so a restart keeps them. */
export class DailyGenerationLimit {
  constructor(
    private readonly db: Db,
    private readonly limit: number,
    private readonly clock: Clock,
  ) {}

  tryConsume(sender: string): boolean {
    const day = this.today();
    this.db.prepare(`
      INSERT INTO generation_usage (sender, day, count) VALUES (?, ?, 0)
      ON CONFLICT (sender, day) DO NOTHING
    `).run(sender, day);

    const result = this.db.prepare(`
      UPDATE generation_usage SET count = count + 1
      WHERE sender = ? AND day = ? AND count < ?
    `).run(sender, day, this.limit);
    return result.changes === 1;
  }

  refund(sender: string): void {
    this.db.prepare(`
      UPDATE generation_usage SET count = count - 1
      WHERE sender = ? AND day = ? AND count > 0
    `).run(sender, this.today());
  }

  private today(): string {
    return new Date(this.clock.now()).toISOString().slice(0, 10);
  }
}
