import {mkdtempSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {describe, expect, it} from 'vitest';
import {ConfigError, loadConfig, networkToChain} from '../../src/config';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'nnb-config-'));
}

const validYaml = `
telegram:
  botToken: "123456:FROMFILE"
bitcoin:
  network: regtest
  rpc:
    url: "http://127.0.0.1:18443"
    user: "rpcuser"
    password: "rpcpass"
storage:
  path: "data/test.db"
ibdMonitor:
  progressStepPercent: 5
  sampleIntervalSeconds: 30
`;

describe('loadConfig', () => {
  it('loads a YAML file and applies defaults', () => {
    const dir = tempDir();
    const path = join(dir, 'config.yaml');
    writeFileSync(path, validYaml);

    const config = loadConfig({path, env: {}});

    expect(config.telegram.botToken).toBe('123456:FROMFILE');
    expect(config.bitcoin.network).toBe('regtest');
    expect(config.bitcoin.rpc.timeoutMs).toBe(5000);
    expect(config.storage).toEqual({path: 'data/test.db'});
    expect(config.ibdMonitor.progressStepPercent).toBe(5);
    expect(config.ibdMonitor.sampleIntervalSeconds).toBe(30);
  });

  it('lets environment variables override secrets and paths', () => {
    const dir = tempDir();
    const path = join(dir, 'config.yaml');
    writeFileSync(path, validYaml);

    const config = loadConfig({
      path,
      env: {
        TELEGRAM_BOT_TOKEN: '999:FROMENV',
        BITCOIN_RPC_USER: 'envuser',
        BITCOIN_RPC_PASSWORD: 'envpass',
        STORAGE_PATH: '/tmp/override.db',
      },
    });

    expect(config.telegram.botToken).toBe('999:FROMENV');
    expect(config.bitcoin.rpc.user).toBe('envuser');
    expect(config.bitcoin.rpc.password).toBe('envpass');
    expect(config.storage).toEqual({path: '/tmp/override.db'});
  });

  it('supports env-only configuration when no config file exists', () => {
    const cwd = process.cwd();
    process.chdir(tempDir());
    try {
      const config = loadConfig({
        env: {
          TELEGRAM_BOT_TOKEN: '123:ENVONLY',
          BITCOIN_RPC_USER: 'envuser',
          BITCOIN_RPC_PASSWORD: 'envpass',
        },
      });

      expect(config.telegram.botToken).toBe('123:ENVONLY');
      expect(config.bitcoin.network).toBe('mainnet');
      expect(config.storage.path).toBe('data/bot.db');
      expect(config.bitcoin.rpc.user).toBe('envuser');
      expect(config.bitcoin.rpc.password).toBe('envpass');
    } finally {
      process.chdir(cwd);
    }
  });

  it('requires RPC auth', () => {
    const dir = tempDir();
    const path = join(dir, 'config.yaml');
    writeFileSync(
      path,
      `
telegram:
  botToken: "1:2"
bitcoin:
  rpc:
    url: "http://127.0.0.1:8332"
`,
    );

    expect(() => loadConfig({path, env: {}})).toThrow(ConfigError);
    expect(() => loadConfig({path, env: {}})).toThrow(/both user and password/);
  });

  it('rejects the removed cookieFile option', () => {
    const dir = tempDir();
    const path = join(dir, 'config.yaml');
    writeFileSync(
      path,
      `
telegram:
  botToken: "1:2"
bitcoin:
  rpc:
    url: "http://127.0.0.1:8332"
    cookieFile: "/tmp/.cookie"
`,
    );

    expect(() => loadConfig({path, env: {}})).toThrow(/cookieFile/);
  });

  it('requires both user and password', () => {
    const dir = tempDir();
    const path = join(dir, 'config.yaml');
    writeFileSync(
      path,
      `
telegram:
  botToken: "1:2"
bitcoin:
  rpc:
    url: "http://127.0.0.1:8332"
    user: "rpcuser"
`,
    );

    expect(() => loadConfig({path, env: {}})).toThrow(/both user and password/);
  });

  it('rejects an explicitly missing config file', () => {
    expect(() =>
      loadConfig({path: join(tempDir(), 'missing.yaml'), env: {}}),
    ).toThrow(/not found/);
  });

  it('rejects a placeholder token', () => {
    const dir = tempDir();
    const path = join(dir, 'config.yaml');
    writeFileSync(path, validYaml.replace('123456:FROMFILE', '123456:ABC...'));

    expect(() => loadConfig({path, env: {}})).toThrow(/placeholder/);
  });
});

describe('networkToChain', () => {
  it('maps networks to Bitcoin Core chain names', () => {
    expect(networkToChain('mainnet')).toBe('main');
    expect(networkToChain('testnet')).toBe('test');
    expect(networkToChain('signet')).toBe('signet');
    expect(networkToChain('regtest')).toBe('regtest');
  });
});
