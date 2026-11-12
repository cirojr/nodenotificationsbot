import {chmodSync, mkdirSync} from 'node:fs';
import {dirname} from 'node:path';
import Database from 'better-sqlite3';
import type {Logger} from '../logger';

export type SqliteDatabase = Database.Database;

interface Migration {
  version: number;
  name: string;
  sql: string;
}

/**
 * Migrations are embedded so the compiled output never depends on copied .sql
 * files. `PRAGMA user_version` tracks the applied version.
 *
 * v0.1 shipped migrations 1-2 for the old per-subscription table. There is no
 * production data yet, so v3 drops that table and replaces it with the lean
 * `monitored_chats` table.
 */
const MIGRATIONS: Migration[] = [
  {
    version: 3,
    name: 'monitored_chats',
    sql: `
      DROP TABLE IF EXISTS node_monitor_subscriptions;

      CREATE TABLE monitored_chats (
        chat_id          INTEGER PRIMARY KEY,
        last_state       TEXT NOT NULL DEFAULT 'unknown'
                           CHECK (last_state IN ('unknown','ibd','synced','unreachable')),
        last_sent_bucket INTEGER,
        created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
    `,
  },
];

export function openSqlite(path: string, logger: Logger): SqliteDatabase {
  if (path !== ':memory:') {
    const directory = dirname(path);
    if (directory && directory !== '.') {
      mkdirSync(directory, {recursive: true, mode: 0o700});
    }
  }

  const db = new Database(path);
  db.pragma('busy_timeout = 5000');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');

  if (path !== ':memory:') {
    // The systemd unit uses UMask=0077; enforce 0600 here too for non-systemd runs.
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        chmodSync(`${path}${suffix}`, 0o600);
      } catch {
        // the -wal/-shm files may not exist yet
      }
    }
  }

  migrate(db, logger);
  return db;
}

export function migrate(db: SqliteDatabase, logger: Logger): number {
  const current = Number(db.pragma('user_version', {simple: true}));
  let applied = current;

  for (const migration of MIGRATIONS) {
    if (migration.version <= applied) {
      continue;
    }
    const run = db.transaction(() => {
      db.exec(migration.sql);
      db.pragma(`user_version = ${migration.version}`);
    });
    run();
    logger.info(
      {version: migration.version, name: migration.name},
      'applied SQLite migration',
    );
    applied = migration.version;
  }

  return applied;
}
