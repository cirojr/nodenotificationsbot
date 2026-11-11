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
 */
const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'node_monitor_subscriptions',
    sql: `
      CREATE TABLE IF NOT EXISTS node_monitor_subscriptions (
        id                    INTEGER PRIMARY KEY AUTOINCREMENT,
        telegram_chat_id      INTEGER NOT NULL UNIQUE,
        progress_step_percent INTEGER NOT NULL DEFAULT 10
                                CHECK (progress_step_percent BETWEEN 1 AND 50),
        active                INTEGER NOT NULL DEFAULT 1,
        last_state            TEXT NOT NULL DEFAULT 'unknown'
                                CHECK (last_state IN ('unknown','ibd','synced','stalled','regressed','unreachable')),
        last_sent_progress    REAL,
        last_progress_bucket  INTEGER,
        last_sent_at          TEXT,
        last_alert_at         TEXT,
        created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );

      CREATE INDEX IF NOT EXISTS node_monitor_subscriptions_active
        ON node_monitor_subscriptions (active) WHERE active = 1;
    `,
  },
  {
    version: 2,
    name: 'drop_last_progress_bucket',
    sql: `
      ALTER TABLE node_monitor_subscriptions
        DROP COLUMN last_progress_bucket;
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

export function latestMigrationVersion(): number {
  return MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0;
}
