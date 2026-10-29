import { assistantMessage, ScriptedModel } from '@openai/agents/testing';
import { describe, expect, it } from 'vitest';
import type { AgentInputItem } from '@openai/agents';
import { StickerAgent } from '../../src/agent/sticker-agent.js';
import { SQLiteAgentSessionStore } from '../../src/agent/sqlite-session-store.js';
import type { Clock } from '../../src/clock.js';
import { openDatabase, type Db } from '../../src/db/database.js';
import type { ImageGenerator } from '../../src/openrouter/image-generator.js';
import { StubImageGenerator } from '../../src/sim/stub-image-generator.js';

const sender = 'session-test';

describe('SQLiteAgentSessionStore', () => {
  it('persists history while the Runner writes through a live session', async () => {
    const clock = { now: () => 1_000 };
    const db = openDatabase(':memory:');
    const store = new SQLiteAgentSessionStore(db, 60_000, clock);

    const session = store.get(sender);
    await session.addItems([{ type: 'message', role: 'user', content: 'um gato laranja' } as AgentInputItem]);

    expect(storedItems(db)).toEqual([{ type: 'message', role: 'user', content: 'um gato laranja' }]);
    const row = db.prepare(`SELECT updated_at FROM agent_sessions WHERE sender = ?`).get(sender) as { updated_at: number };
    expect(row.updated_at).toBe(1_000);
  });

  it('continues a conversation after a cold start of the app', async () => {
    const clock = { now: () => 2_000 };
    const db = openDatabase(':memory:');
    const warm = new SQLiteAgentSessionStore(db, 60_000, clock);
    await warm.get(sender).addItems([{ type: 'message', role: 'user', content: 'faz um gato' } as AgentInputItem]);

    // "Restart": a brand-new store over the same recovered database.
    const cold = new SQLiteAgentSessionStore(db, 60_000, clock);
    const history = await cold.get(sender).getItems();
    expect(history).toEqual([{ type: 'message', role: 'user', content: 'faz um gato' }]);
  });

  it('starts a clean conversation once the silence outlasts the TTL', async () => {
    const db = openDatabase(':memory:');
    const warm = new SQLiteAgentSessionStore(db, 100, { now: () => 1_000 });
    await warm.get(sender).addItems([{ type: 'message', role: 'user', content: 'old' } as AgentInputItem]);

    const cold = new SQLiteAgentSessionStore(db, 100, { now: () => 5_000 });
    // The stale row is kept (not deleted on wake) so the bot can report that the old
    // conversation expired; the session itself starts from zero.
    expect(await cold.get(sender).getItems()).toEqual([]);
    expect(rowCount(db)).toBe(1);
    expect(cold.hasExpiredContext(sender)).toBe(true);
  });

  it('reports whether a returning conversation context has expired', async () => {
    const db = openDatabase(':memory:');
    const store = new SQLiteAgentSessionStore(db, 100, { now: () => 10_000 });

    // No row at all: a fresh user, nothing expired.
    expect(store.hasExpiredContext(sender)).toBe(false);

    await store.get(sender).addItems([{ type: 'message', role: 'user', content: 'olá' } as AgentInputItem]);
    expect(store.hasExpiredContext(sender)).toBe(false);

    const stale = new SQLiteAgentSessionStore(db, 100, { now: () => 50_000 });
    expect(stale.hasExpiredContext(sender)).toBe(true);
    // The turn then persists fresh content, which ends the signal.
    await stale.get(sender).addItems([{ type: 'message', role: 'user', content: 'de novo' } as AgentInputItem]);
    expect(stale.hasExpiredContext(sender)).toBe(false);
  });

  it('clears the row and ignores writes from a turn that was cleared mid-flight', async () => {
    const db = openDatabase(':memory:');
    const store = new SQLiteAgentSessionStore(db, 60_000, { now: () => 7_000 });
    const session = store.get(sender);
    await session.addItems([{ type: 'message', role: 'user', content: 'old talk' } as AgentInputItem]);

    await store.clear(sender);
    expect(rowCount(db)).toBe(0);

    // The in-flight session was created before the clear; its writes must be ignored.
    await session.addItems([{ type: 'message', role: 'user', content: 'late write' } as AgentInputItem]);
    expect(rowCount(db)).toBe(0);

    // A fresh session works normally again.
    await store.get(sender).addItems([{ type: 'message', role: 'user', content: 'novo tema' } as AgentInputItem]);
    expect(rowCount(db)).toBe(1);
  });

  it('enforces the item cap while keeping call/result pairs intact', async () => {
    const db = openDatabase(':memory:');
    const store = new SQLiteAgentSessionStore(db, 60_000, { now: () => 5_000 }, 3);

    await store.get(sender).addItems([
      { type: 'message', role: 'user', content: 'turn 1' },
      { type: 'function_call', callId: 'c1', name: 'make_sticker', arguments: '{}' },
      { type: 'function_call_result', callId: 'c1', output: '{"ok":true}' },
      { type: 'message', role: 'user', content: 'turn 2' },
      { type: 'function_call', callId: 'c2', name: 'make_sticker', arguments: '{}' },
    ] as AgentInputItem[]);

    expect(storedItems(db)).toEqual([
      { type: 'function_call', callId: 'c1', name: 'make_sticker', arguments: '{}' },
      { type: 'function_call_result', callId: 'c1', output: '{"ok":true}' },
      { type: 'message', role: 'user', content: 'turn 2' },
    ]);
  });

  it('feeds prior history to a real agent turn after a cold start', async () => {
    const db = openDatabase(':memory:');

    const first = new ScriptedModel([[assistantMessage('Me mande uma descrição, uma foto ou um sticker!')]]);
    const agentWarm = agentOver(db, first);
    await agentWarm.runTurn({ sender, userText: 'um gato laranja', newAssetIds: [] });

    const second = new ScriptedModel([[assistantMessage('Entendi, o gato de novo?')]]);
    const agentCold = agentOver(db, second);
    await agentCold.runTurn({ sender, userText: 'mais um, na cor azul', newAssetIds: [] });

    const coldInput = JSON.stringify(second.calls[0]?.request.input);
    expect(coldInput).toContain('um gato laranja');
    expect(coldInput).toContain('Me mande uma descrição');
  });
});

function agentOver(db: Db, model: ScriptedModel) {
  return new StickerAgent({
    config: { apiKey: 't', baseUrl: 'x', agentModel: 'm', imageModel: 'img', siteUrl: 'x', appName: 't' },
    imageGenerator: new StubImageGenerator() as ImageGenerator,
    assets: { list: () => [], get: () => undefined } as never,
    sessions: new SQLiteAgentSessionStore(db, 60_000, { now: () => 1 } as Clock),
    budget: { tryConsume: () => true, refund: () => undefined } as never,
    whatsapp: { sendText: async () => ({ wamid: null }), sendSticker: async () => ({ wamid: null }), downloadMedia: async () => {
      throw new Error('not used');
    } } as never,
    modelProvider: { getModel: () => model },
  });
}

function storedItems(db: Db, who = sender): unknown[] {
  const row = db.prepare(`SELECT items FROM agent_sessions WHERE sender = ?`).get(who) as { items: string };
  return JSON.parse(row.items) as unknown[];
}

function rowCount(db: Db): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM agent_sessions`).get() as { n: number }).n;
}
