import {describe, expect, it} from 'vitest';
import {
  computeRpcauthHash,
  formatRpcauthLine,
  generateRpcauth,
  generateRpcauthPassword,
  generateRpcauthSalt,
  parseRpcauthLine,
} from '../../src/bitcoin/rpcauth';

// Vector produced by Bitcoin Core's share/rpcauth/rpcauth.py.
const SALT = '0123456789abcdef0123456789abcdef';
const PASSWORD = 'correct horse battery staple';
const HASH = '90ff3ce205bece1c447b777562931b92721a1956552484506bf368ee0278bcd3';

describe('rpcauth', () => {
  it('matches the Bitcoin Core rpcauth.py vector', () => {
    expect(computeRpcauthHash(SALT, PASSWORD)).toBe(HASH);
    expect(formatRpcauthLine('nodenotificationsbot', SALT, HASH)).toBe(
      `rpcauth=nodenotificationsbot:${SALT}$${HASH}`,
    );
  });

  it('generates a parseable pair with a random salt and password', () => {
    const credential = generateRpcauth('nodenotificationsbot');

    expect(credential.password.length).toBeGreaterThan(0);
    expect(credential.salt).toMatch(/^[0-9a-f]{32}$/);
    expect(credential.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(credential.hash).toBe(
      computeRpcauthHash(credential.salt, credential.password),
    );
    expect(parseRpcauthLine(credential.line)).toEqual({
      user: 'nodenotificationsbot',
      salt: credential.salt,
      hash: credential.hash,
    });
  });

  it('uses a supplied password', () => {
    const credential = generateRpcauth('bot', PASSWORD);

    expect(credential.password).toBe(PASSWORD);
    expect(credential.hash).toBe(computeRpcauthHash(credential.salt, PASSWORD));
  });

  it('generates Core-compatible salt and password shapes', () => {
    expect(generateRpcauthSalt()).toMatch(/^[0-9a-f]{32}$/);
    expect(generateRpcauthPassword()).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('rejects malformed lines, users, and passwords', () => {
    expect(() => parseRpcauthLine('rpcuser=x')).toThrow(/expected rpcauth/);
    expect(() => parseRpcauthLine(`rpcauth=bot:${SALT}$short`)).toThrow(
      /expected rpcauth/,
    );
    expect(() => generateRpcauth('bad user')).toThrow(/no colon or whitespace/);
    expect(() => generateRpcauth('bot', '')).toThrow(/must not be empty/);
    expect(() => computeRpcauthHash('not-a-salt', PASSWORD)).toThrow(
      /32 lowercase hex/,
    );
  });
});
