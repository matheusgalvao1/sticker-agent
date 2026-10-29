import type { Clock } from '../clock.js';
import type { Db } from '../db/database.js';

export interface GenerationCostRecorder {
  record(sender: string, model: string, costUsd: number | null): void;
}

/**
 * Writes one row per image generation, with the real cost OpenRouter reported for the
 * call. When the provider sends no usage.cost the row is still written, with a null cost,
 * so generation volume stays auditable even when billing data is missing.
 */
export class SqliteGenerationCostRecorder implements GenerationCostRecorder {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
  ) {}

  record(sender: string, model: string, costUsd: number | null): void {
    // The sticker already exists by the time this runs; a bookkeeping failure must
    // never fail the turn, so insert errors are swallowed.
    try {
      this.db.prepare(`
        INSERT INTO generation_costs (sender, model, cost_usd, created_at)
        VALUES (?, ?, ?, ?)
      `).run(sender, model, costUsd, this.clock.now());
    } catch {}
  }
}
