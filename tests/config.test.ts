import { describe, expect, it } from 'vitest';
import { normalizePhoneNumber } from '../src/config.js';

describe('normalizePhoneNumber', () => {
  it('keeps digits only', () => {
    expect(normalizePhoneNumber('+1 (555) 123-4567')).toBe('15551234567');
  });

  it('maps a Brazilian mobile without the extra 9 to the 13-digit form', () => {
    expect(normalizePhoneNumber('554298420077')).toBe('5542998420077');
  });

  it('leaves the 13-digit Brazilian mobile form unchanged', () => {
    expect(normalizePhoneNumber('+55 42 998420077')).toBe('5542998420077');
  });

  it('leaves Brazilian landlines unchanged', () => {
    expect(normalizePhoneNumber('554232221100')).toBe('554232221100');
  });

  it('leaves other countries unchanged', () => {
    expect(normalizePhoneNumber('447700900123')).toBe('447700900123');
  });
});
