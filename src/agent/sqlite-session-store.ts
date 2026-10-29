import { MemorySession, type AgentInputItem, type SessionHistoryTransactionArgs } from '@openai/agents';
import type { Clock } from '../clock.js';
import type { Db } from '../db/database.js';
import { DEFAULT_MAX_SESSION_ITEMS, loadSessionItems, trimSessionHistory } from './session-history.js';

class SQLiteBackedSession extends MemorySession {
  constructor(
    initialItems: AgentInputItem[],
    private readonly persistCurrent: (items: AgentInputItem[]) => void,
    sessionId: string,
  ) {
    super({ sessionId, initialItems });
  }

  async addItems(items: AgentInputItem[]): Promise<void> {
    await super.addItems(items);
    this.persistCurrent(this.currentItems());
  }

  async popItem(): Promise<AgentInputItem | undefined> {
    const item = await super.popItem();
    this.persistCurrent(this.currentItems());
    return item;
  }

  async clearSession(): Promise<void> {
    await super.clearSession();
    this.persistCurrent([]);
  }

  async applyHistoryTransaction(args: SessionHistoryTransactionArgs): Promise<void> {
    await super.applyHistoryTransaction(args);
    this.persistCurrent(this.currentItems());
  }

  /**
   * The item list is a plain array on MemorySession, but declared private in the SDK's
   * type definitions. Reading it by way of this escape hatch keeps the persistence layer
   * a subclass of MemorySession — so the Runner still sees the session protocol it knows
   * (transactions, compaction ownership checks) instead of a hand-rolled reimplementation.
   */
  private currentItems(): AgentInputItem[] {
    return [...(this as unknown as { items: AgentInputItem[] }).items];
  }
}

/**
 * Conversation history persisted per sender in SQLite. Each turn is served a MemorySession
 * seeded with the last stored window; the run keeps behaving as it always did, and every
 * write the Runner makes during the turn is mirrored back — trimmed — into the database.
 * A restart, a deploy, or the machine going to sleep therefore loses nothing, while silence
 * longer than `MEMORY_TTL_MINUTES` starts a clean conversation.
 */
export class SQLiteAgentSessionStore {
  private readonly maxItems: number;
  private readonly generations = new Map<string, number>();

  constructor(
    private readonly db: Db,
    private readonly ttlMs: number,
    private readonly clock: Clock,
    maxItems: number = DEFAULT_MAX_SESSION_ITEMS,
  ) {
    this.maxItems = maxItems;
    // Idle sessions expire exactly the way the previous in-process ones did; the row is
    // simply dropped once its conversation has been silent for longer than the TTL.
    this.expirePreviousSessions();
  }

  get(sender: string): MemorySession {
    const generation = this.generations.get(sender) ?? 0;
    const row = this.db
      .prepare(`SELECT items, updated_at FROM agent_sessions WHERE sender = ?`)
      .get(sender) as { items: string; updated_at: number } | undefined;

    const fresh = row !== undefined && this.clock.now() - row.updated_at <= this.ttlMs;
    const seedItems = fresh ? trimSessionHistory(loadSessionItems(row.items), this.maxItems) : [];

    return new SQLiteBackedSession(
      seedItems as AgentInputItem[],
      (items) => this.persist(sender, generation, items),
      `whatsapp:${sender}`,
    );
  }

  async clear(sender: string): Promise<void> {
    try {
      // Bump the generation first so writes from an in-flight turn of the cleared
      // conversation cannot resurrect old history after the delete lands.
      this.generations.set(sender, (this.generations.get(sender) ?? 0) + 1);
      this.db.prepare(`DELETE FROM agent_sessions WHERE sender = ?`).run(sender);
    } catch {}
  }

  private persist(sender: string, generation: number, items: AgentInputItem[]): void {
    if ((this.generations.get(sender) ?? 0) !== generation) return;

    // Persistence must never break a running turn, so database errors are swallowed —
    // the worst case is losing the newest stretch of history, like the in-memory TTL did.
    try {
      const trimmed = trimSessionHistory(items, this.maxItems);
      this.db.prepare(`
        INSERT INTO agent_sessions (sender, items, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(sender) DO UPDATE SET items = excluded.items, updated_at = excluded.updated_at
      `).run(sender, JSON.stringify(trimmed), this.clock.now());
    } catch {}
  }

  private expirePreviousSessions(): void {
    try {
      this.db.prepare(`DELETE FROM agent_sessions WHERE updated_at < ?`).run(this.clock.now() - this.ttlMs);
    } catch {}
  }
}
