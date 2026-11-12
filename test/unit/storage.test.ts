import {existsSync, mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {describe, expect, it} from 'vitest';
import {createStorage} from '../../src/storage';
import {SqliteMonitoredChatRepo} from '../../src/storage/monitoredChatRepo';
import {openSqlite} from '../../src/storage/sqlite';
import {silentLogger} from '../helpers';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'nnb-storage-'));
}

describe('SQLite storage', () => {
  it('migrates, persists and reopens monitored chats', () => {
    const path = join(tempDir(), 'nested', 'bot.db');

    const first = createStorage(path, silentLogger);
    first.chats.add(42);
    expect(first.chats.get(42)?.lastState).toBe('unknown');
    expect(first.chats.get(42)?.lastSentBucket).toBeNull();

    first.chats.update(42, {lastState: 'ibd', lastSentBucket: 8});
    first.close();

    expect(existsSync(path)).toBe(true);

    const second = createStorage(path, silentLogger);
    const loaded = second.chats.get(42);
    expect(loaded).not.toBeNull();
    expect(loaded?.chatId).toBe(42);
    expect(loaded?.lastState).toBe('ibd');
    expect(loaded?.lastSentBucket).toBe(8);

    const db = openSqlite(path, silentLogger);
    expect(Number(db.pragma('user_version', {simple: true}))).toBe(3);
    const columns = db
      .prepare('PRAGMA table_info(monitored_chats)')
      .all() as Array<{name: string}>;
    expect(columns.map(column => column.name)).toEqual([
      'chat_id',
      'last_state',
      'last_sent_bucket',
      'created_at',
    ]);
    db.close();
    second.close();
  });

  it('adds, updates, lists and removes chats', () => {
    const repo = new SqliteMonitoredChatRepo(
      openSqlite(':memory:', silentLogger),
    );
    repo.add(1);
    repo.add(2);
    repo.add(1);

    expect(repo.list().map(chat => chat.chatId)).toEqual([1, 2]);
    expect(repo.get(1)?.lastState).toBe('unknown');
    expect(repo.get(1)?.lastSentBucket).toBeNull();

    repo.update(1, {lastState: 'ibd', lastSentBucket: 4});
    expect(repo.get(1)?.lastState).toBe('ibd');
    expect(repo.get(1)?.lastSentBucket).toBe(4);

    expect(repo.remove(1)).toBe(true);
    expect(repo.remove(999)).toBe(false);
    expect(repo.list().map(chat => chat.chatId)).toEqual([2]);
    repo.close();
  });
});
