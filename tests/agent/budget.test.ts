import { describe, expect, it } from 'vitest';
import { DailyGenerationLimit } from '../../src/agent/budget.js';
import { openDatabase } from '../../src/db/database.js';

const sender = '5542998765432';
const noon = Date.UTC(2026, 9, 18, 12);

describe('DailyGenerationLimit', () => {
  it('stops at the daily limit and frees a slot on refund', () => {
    const limit = new DailyGenerationLimit(openDatabase(':memory:'), 2, { now: () => noon });

    expect(limit.tryConsume(sender)).toBe(true);
    expect(limit.tryConsume(sender)).toBe(true);
    expect(limit.tryConsume(sender)).toBe(false);

    limit.refund(sender);
    expect(limit.tryConsume(sender)).toBe(true);
  });

  it('keeps counts across instances on the same database, so a restart cannot reset them', () => {
    const db = openDatabase(':memory:');
    const clock = { now: () => noon };

    expect(new DailyGenerationLimit(db, 1, clock).tryConsume(sender)).toBe(true);
    expect(new DailyGenerationLimit(db, 1, clock).tryConsume(sender)).toBe(false);
  });

  it('starts a new count on the next UTC day', () => {
    let now = Date.UTC(2026, 9, 18, 23);
    const limit = new DailyGenerationLimit(openDatabase(':memory:'), 1, { now: () => now });

    expect(limit.tryConsume(sender)).toBe(true);
    expect(limit.tryConsume(sender)).toBe(false);

    now = Date.UTC(2026, 9, 19, 1);
    expect(limit.tryConsume(sender)).toBe(true);
  });
});
