import {createHmac, randomBytes} from 'node:crypto';

/**
 * Bitcoin Core `rpcauth` credential helpers.
 *
 * `rpcauth` is server-side storage: bitcoin.conf keeps `<salt>$<hash>` where
 * `hash = HMAC-SHA256(salt, password)`. The bot still authenticates with HTTP
 * Basic `user:password`; it never reads or computes the hash at runtime. These
 * helpers exist only to provision a matching pair (offline, once).
 */

export interface RpcauthCredential {
  user: string;
  /** Plaintext password for the bot. Never put this in bitcoin.conf. */
  password: string;
  salt: string;
  hash: string;
  /** Full `rpcauth=user:salt$hash` line for bitcoin.conf. */
  line: string;
}

export interface ParsedRpcauth {
  user: string;
  salt: string;
  hash: string;
}

const SALT_BYTES = 16;
const PASSWORD_BYTES = 32;
const SALT_PATTERN = /^[0-9a-f]{32}$/;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const LINE_PATTERN = /^rpcauth=([^:\s]+):([0-9a-f]{32})\$([0-9a-f]{64})$/;

/** Random 32-byte password, base64url without padding (same shape as Core). */
export function generateRpcauthPassword(): string {
  return randomBytes(PASSWORD_BYTES).toString('base64url');
}

/** Random 16-byte salt as lowercase hex (same shape as Core's rpcauth.py). */
export function generateRpcauthSalt(): string {
  return randomBytes(SALT_BYTES).toString('hex');
}

/** Compute the verifier stored in bitcoin.conf. */
export function computeRpcauthHash(salt: string, password: string): string {
  if (!SALT_PATTERN.test(salt)) {
    throw new Error('rpcauth salt must be 32 lowercase hex characters');
  }
  return createHmac('sha256', salt).update(password, 'utf8').digest('hex');
}

/** Build the `rpcauth=user:salt$hash` line for bitcoin.conf. */
export function formatRpcauthLine(
  user: string,
  salt: string,
  hash: string,
): string {
  assertUser(user);
  if (!SALT_PATTERN.test(salt)) {
    throw new Error('rpcauth salt must be 32 lowercase hex characters');
  }
  if (!HASH_PATTERN.test(hash)) {
    throw new Error('rpcauth hash must be 64 lowercase hex characters');
  }
  return `rpcauth=${user}:${salt}$${hash}`;
}

/**
 * Create a credential pair: the `line` goes to bitcoin.conf and the
 * `password` goes to the bot's environment (mode 0600).
 */
export function generateRpcauth(
  user: string,
  password: string = generateRpcauthPassword(),
): RpcauthCredential {
  assertUser(user);
  if (password.length === 0) {
    throw new Error('rpcauth password must not be empty');
  }
  const salt = generateRpcauthSalt();
  const hash = computeRpcauthHash(salt, password);
  return {
    user,
    password,
    salt,
    hash,
    line: formatRpcauthLine(user, salt, hash),
  };
}

/** Parse and validate an `rpcauth=user:salt$hash` line. */
export function parseRpcauthLine(line: string): ParsedRpcauth {
  const match = LINE_PATTERN.exec(line.trim());
  if (!match) {
    throw new Error('expected rpcauth=<user>:<32 hex salt>$<64 hex hash>');
  }
  const user = match[1];
  const salt = match[2];
  const hash = match[3];
  if (user === undefined || salt === undefined || hash === undefined) {
    throw new Error('rpcauth line is missing a field');
  }
  assertUser(user);
  return {user, salt, hash};
}

function assertUser(user: string): void {
  if (user.length === 0 || user.includes(':') || /\s/.test(user)) {
    throw new Error(
      'rpcauth user must be non-empty and contain no colon or whitespace',
    );
  }
}
