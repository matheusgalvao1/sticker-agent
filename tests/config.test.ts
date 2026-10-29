import { describe, expect, it } from 'vitest';
import { loadConfig, normalizePhoneNumber } from '../src/config.js';

const minimalEnvironment = {
  NODE_ENV: 'development',
  OPENROUTER_API_KEY: 'key',
  WHATSAPP_ACCESS_TOKEN: 'token',
  WHATSAPP_PHONE_NUMBER_ID: '123',
  WHATSAPP_VERIFY_TOKEN: 'verify',
};

describe('loadConfig image quality', () => {
  it('defaults to medium', () => {
    const config = loadConfig({ ...minimalEnvironment });
    expect(config.openRouter.imageQuality).toBe('medium');
  });

  it('accepts every supported quality and passes it through', () => {
    for (const quality of ['auto', 'low', 'medium', 'high', 'xhigh', 'max']) {
      const config = loadConfig({ ...minimalEnvironment, OPENROUTER_IMAGE_QUALITY: quality });
      expect(config.openRouter.imageQuality).toBe(quality);
    }
  });

  it('rejects an unsupported quality', () => {
    expect(() => loadConfig({ ...minimalEnvironment, OPENROUTER_IMAGE_QUALITY: 'ultra' }))
      .toThrow(/Invalid environment configuration/);
  });
});

describe('normalizePhoneNumber', () => {
  it('keeps digits only', () => {
    expect(normalizePhoneNumber('+1 (555) 123-4567')).toBe('15551234567');
  });

  it('maps a Brazilian mobile without the extra 9 to the 13-digit form', () => {
    expect(normalizePhoneNumber('554298765432')).toBe('5542998765432');
  });

  it('leaves the 13-digit Brazilian mobile form unchanged', () => {
    expect(normalizePhoneNumber('+55 42 98765432')).toBe('5542998765432');
  });

  it('leaves Brazilian landlines unchanged', () => {
    expect(normalizePhoneNumber('554232221100')).toBe('554232221100');
  });

  it('leaves other countries unchanged', () => {
    expect(normalizePhoneNumber('447700900123')).toBe('447700900123');
  });
});
