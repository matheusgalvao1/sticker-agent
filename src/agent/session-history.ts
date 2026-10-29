/**
 * Session history items are the Agents SDK's model items — plain JSON objects whose
 * `type` we inspect. Only the fields needed for safe trimming are made visible here.
 */
export interface SessionHistoryItem {
  type?: unknown;
}

export const DEFAULT_MAX_SESSION_ITEMS = 30;

/**
 * Cut a persisted session history down to the newest items without producing input the
 * Chat Completions API will reject. Three rules, in order:
 *
 * 1. Drop trailing tool calls without results (a process crash can leave one behind —
 *    the API rejects a tool call whose result never happens).
 * 2. Slice to the newest `maxItems`.
 * 3. Slide the start forward past orphan tool results, so the replay never begins with a
 *    result whose tool call was cut away. Slicing happens between calls and their results
 *    only at the window borders, and both borders are repaired, so no tool call/result
 *    pair is ever split inside the window.
 */
export function trimSessionHistory(items: unknown[], maxItems: number): unknown[] {
  return trimLeadingOrphanResults(dropTrailingToolCalls(items).slice(-maxItems));
}

function dropTrailingToolCalls(items: unknown[]): unknown[] {
  const kept = [...items];
  while (kept.length > 0 && itemType(kept[kept.length - 1]) === 'function_call') {
    kept.pop();
  }
  return kept;
}

function trimLeadingOrphanResults(items: unknown[]): unknown[] {
  let start = 0;
  while (start < items.length && itemType(items[start]) === 'function_call_result') {
    start += 1;
  }
  return items.slice(start);
}

function itemType(item: unknown): string {
  const value = (item as SessionHistoryItem | null | undefined)?.type;
  return typeof value === 'string' ? value : '';
}

/**
 * Light sanitization for rows loaded from the database: JSON we wrote ourselves should
 * always be an array of objects with a role or a type, but a corrupt or truncated row
 * must degrade to a fresh conversation instead of crashing every future turn.
 */
export function loadSessionItems(json: string): unknown[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(acceptableHistoryItem);
}

function acceptableHistoryItem(item: unknown): boolean {
  if (typeof item !== 'object' || item === null) return false;
  const record = item as { type?: unknown; role?: unknown };
  return typeof record.type === 'string' || typeof record.role === 'string';
}
