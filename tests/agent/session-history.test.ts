import { describe, expect, it } from 'vitest';
import { loadSessionItems, trimSessionHistory } from '../../src/agent/session-history.js';

function userMessage(text: string) {
  return { type: 'message', role: 'user', content: text };
}

function assistantMessage(text: string) {
  return { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] };
}

function toolCall(callId: string) {
  return { type: 'function_call', callId, name: 'make_sticker', arguments: '{}' };
}

function toolResult(callId: string) {
  return { type: 'function_call_result', callId, output: '{"ok":true}' };
}

/** The Chat Completions constraints the trimmer exists to satisfy. */
function expectReplayable(items: unknown[]) {
  if (items.length === 0) return;
  expect(((items[0] as { type?: string }).type)).not.toBe('function_call_result');

  items.forEach((item, index) => {
    const entry = item as { type?: string };
    if (entry.type !== 'function_call') return;
    const next = items[index + 1] as { type?: string; callId?: string } | undefined;
    expect(next?.type).toBe('function_call_result');
    expect(next?.callId).toBe((item as { callId?: string }).callId);
  });
}

describe('trimSessionHistory', () => {
  it('keeps short histories untouched', () => {
    const history = [userMessage('oi'), assistantMessage('O que crio?')];
    expect(trimSessionHistory(history, 30)).toEqual(history);
  });

  it('cuts at item boundaries without splitting a tool call from its result', () => {
    const history = [
      userMessage('turn 1'),
      assistantMessage('cria?'),
      toolCall('t1'),
      toolResult('t1'),
      userMessage('turn 2'),
      assistantMessage('agora rapidinho'),
      toolCall('t2'),
      toolResult('t2'),
      userMessage('turn 3'),
      assistantMessage('prontinho, ta aí'),
    ];

    for (const maxItems of [3, 4, 5, 6]) {
      const trimmed = trimSessionHistory(history, maxItems);
      expect(trimmed.length).toBeLessThanOrEqual(maxItems);
      expectReplayable(trimmed);
    }
  });

  it('never opens the replay with an orphan tool result from a cut window', () => {
    // A window that would start on result('c1') slides forward to the next user message.
    const history = [
      userMessage('turn 1'),
      toolCall('c1'),
      toolResult('c1'),
      userMessage('turn 2'),
      toolCall('c2'),
      toolResult('c2'),
    ];
    const trimmed = trimSessionHistory(history, 4);
    expect(trimmed).toEqual([userMessage('turn 2'), toolCall('c2'), toolResult('c2')]);
    expectReplayable(trimmed);
  });

  it('drops trailing tool calls left behind by a crashed turn', () => {
    const history = [
      userMessage('oi'),
      assistantMessage('fazendo…'),
      toolCall('done'),
      toolResult('done'),
      toolCall('ghost'),
    ];
    expect(trimSessionHistory(history, 30)).toEqual([
      userMessage('oi'),
      assistantMessage('fazendo…'),
      toolCall('done'),
      toolResult('done'),
    ]);
  });
});

describe('loadSessionItems', () => {
  it('parses a stored array and drops corrupt entries', () => {
    const stored = JSON.stringify([userMessage('oi'), 42, null, 'hi', toolCall('c1')]);
    expect(loadSessionItems(stored)).toEqual([userMessage('oi'), toolCall('c1')]);
  });

  it('returns an empty history for garbage instead of crashing', () => {
    expect(loadSessionItems('not json {')).toEqual([]);
    expect(loadSessionItems('"plain string"')).toEqual([]);
    expect(loadSessionItems('[{}]')).toEqual([]);
  });
});
