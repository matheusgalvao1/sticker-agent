import { describe, expect, it } from 'vitest';
import { AccountService } from '../../src/accounts/service.js';
import { openDatabase } from '../../src/db/database.js';

function setup() {
  let now = 1_000;
  const db = openDatabase(':memory:');
  const accounts = new AccountService(db, { now: () => now });
  return { accounts, db, advance: (ms: number) => { now += ms; } };
}

describe('AccountService', () => {
  it('creates an account on the first message and reuses it afterwards', () => {
    const { accounts } = setup();

    const first = accounts.getOrCreateUser('15551234567');
    const second = accounts.getOrCreateUser('15551234567');

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.user.id).toBe(first.user.id);
    expect(second.user).toMatchObject({ whatsappId: '15551234567', status: 'active' });
  });

  it('keeps separate accounts for separate numbers', () => {
    const { accounts } = setup();

    const ana = accounts.getOrCreateUser('15551234567').user;
    const bruno = accounts.getOrCreateUser('15557654321').user;

    expect(bruno.id).not.toBe(ana.id);
    expect(accounts.findUser('15557654321')?.id).toBe(bruno.id);
  });

  it('does not create an account when only looking one up', () => {
    const { accounts } = setup();

    expect(accounts.findUser('15550000000')).toBeUndefined();
  });

  it('keeps accounts across time', () => {
    const { accounts, advance } = setup();
    const { user } = accounts.getOrCreateUser('15551234567');

    advance(365 * 24 * 60 * 60_000);

    expect(accounts.findUser('15551234567')?.id).toBe(user.id);
  });
});
