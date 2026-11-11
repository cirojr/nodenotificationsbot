import {existsSync, mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {describe, expect, it} from 'vitest';
import {createStorage} from '../../src/storage';
import {SqliteNodeMonitorRepo} from '../../src/storage/nodeMonitorRepo';
import {latestMigrationVersion, openSqlite} from '../../src/storage/sqlite';
import {silentLogger} from '../helpers';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'nnb-storage-'));
}

describe('SQLite storage', () => {
  it('migrates, persists and reopens subscription state', () => {
    const path = join(tempDir(), 'nested', 'bot.db');

    const first = createStorage({driver: 'sqlite', path}, silentLogger);
    const created = first.repo.create(42, 10);
    expect(created.telegramChatId).toBe(42);
    expect(created.progressStepPercent).toBe(10);
    expect(created.active).toBe(true);
    expect(created.lastState).toBe('unknown');
    expect(created.lastSentProgress).toBeNull();

    first.repo.update(42, {
      lastState: 'ibd',
      lastSentProgress: 88.73,
      lastSentAt: '2026-11-08T14:07:31.000Z',
    });
    first.close();

    expect(existsSync(path)).toBe(true);

    const second = createStorage({driver: 'sqlite', path}, silentLogger);
    const loaded = second.repo.getByChatId(42);
    expect(loaded).not.toBeNull();
    expect(loaded?.lastState).toBe('ibd');
    expect(loaded?.lastSentProgress).toBeCloseTo(88.73);
    expect(loaded?.lastSentAt).toBe('2026-11-08T14:07:31.000Z');

    // Migrations are idempotent.
    const db = openSqlite(path, silentLogger);
    expect(Number(db.pragma('user_version', {simple: true}))).toBe(
      latestMigrationVersion(),
    );
    const columns = db
      .prepare('PRAGMA table_info(node_monitor_subscriptions)')
      .all() as Array<{name: string}>;
    expect(columns.map(column => column.name)).not.toContain(
      'last_progress_bucket',
    );
    db.close();
    second.close();
  });

  it('counts and deactivates subscriptions', () => {
    const repo = new SqliteNodeMonitorRepo(
      openSqlite(':memory:', silentLogger),
    );
    repo.create(1, 10);
    repo.create(2, 5);
    expect(repo.countActive()).toBe(2);
    expect(repo.listActive().map(sub => sub.telegramChatId)).toEqual([1, 2]);

    expect(repo.setActive(1, false)).toBe(true);
    expect(repo.countActive()).toBe(1);
    expect(repo.setActive(999, false)).toBe(false);
    expect(repo.listActive().map(sub => sub.telegramChatId)).toEqual([2]);
  });

  it('rejects duplicate chat ids', () => {
    const repo = new SqliteNodeMonitorRepo(
      openSqlite(':memory:', silentLogger),
    );
    repo.create(1, 10);
    expect(() => repo.create(1, 10)).toThrow();
  });
});
