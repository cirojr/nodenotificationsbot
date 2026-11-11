import type {Logger} from '../logger';
import type {
  MonitorState,
  NodeMonitorSubscriptionRepo,
  Storage,
  Subscription,
  SubscriptionPatch,
} from './index';
import {openSqlite, type SqliteDatabase} from './sqlite';

interface SubscriptionRow {
  id: number;
  telegram_chat_id: number;
  progress_step_percent: number;
  active: number;
  last_state: string;
  last_sent_progress: number | null;
  last_sent_at: string | null;
  last_alert_at: string | null;
  created_at: string;
  updated_at: string;
}

type SqlValue = string | number | null;

function nowIso(): string {
  return new Date().toISOString();
}

function mapRow(row: SubscriptionRow): Subscription {
  return {
    id: row.id,
    telegramChatId: row.telegram_chat_id,
    progressStepPercent: row.progress_step_percent,
    active: row.active === 1,
    lastState: row.last_state as MonitorState,
    lastSentProgress: row.last_sent_progress,
    lastSentAt: row.last_sent_at,
    lastAlertAt: row.last_alert_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class SqliteNodeMonitorRepo implements NodeMonitorSubscriptionRepo {
  private readonly db: SqliteDatabase;

  constructor(db: SqliteDatabase) {
    this.db = db;
  }

  getByChatId(chatId: number): Subscription | null {
    const row = this.db
      .prepare(
        'SELECT * FROM node_monitor_subscriptions WHERE telegram_chat_id = ?',
      )
      .get(chatId) as SubscriptionRow | undefined;
    return row ? mapRow(row) : null;
  }

  listActive(): Subscription[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM node_monitor_subscriptions WHERE active = 1 ORDER BY id',
      )
      .all() as SubscriptionRow[];
    return rows.map(mapRow);
  }

  countActive(): number {
    const row = this.db
      .prepare(
        'SELECT COUNT(*) AS count FROM node_monitor_subscriptions WHERE active = 1',
      )
      .get() as {count: number};
    return row.count;
  }

  create(chatId: number, progressStepPercent: number): Subscription {
    this.db
      .prepare(
        `INSERT INTO node_monitor_subscriptions (telegram_chat_id, progress_step_percent, active)
         VALUES (?, ?, 1)`,
      )
      .run(chatId, progressStepPercent);
    const created = this.getByChatId(chatId);
    if (!created) {
      throw new Error(`failed to read back subscription for chat ${chatId}`);
    }
    return created;
  }

  update(chatId: number, patch: SubscriptionPatch): void {
    const fields: string[] = [];
    const values: SqlValue[] = [];

    if (patch.progressStepPercent !== undefined) {
      fields.push('progress_step_percent = ?');
      values.push(patch.progressStepPercent);
    }
    if (patch.active !== undefined) {
      fields.push('active = ?');
      values.push(patch.active ? 1 : 0);
    }
    if (patch.lastState !== undefined) {
      fields.push('last_state = ?');
      values.push(patch.lastState);
    }
    if (patch.lastSentProgress !== undefined) {
      fields.push('last_sent_progress = ?');
      values.push(patch.lastSentProgress);
    }
    if (patch.lastSentAt !== undefined) {
      fields.push('last_sent_at = ?');
      values.push(patch.lastSentAt);
    }
    if (patch.lastAlertAt !== undefined) {
      fields.push('last_alert_at = ?');
      values.push(patch.lastAlertAt);
    }

    fields.push('updated_at = ?');
    values.push(nowIso());
    values.push(chatId);

    this.db
      .prepare(
        `UPDATE node_monitor_subscriptions SET ${fields.join(', ')} WHERE telegram_chat_id = ?`,
      )
      .run(...values);
  }

  setActive(chatId: number, active: boolean): boolean {
    const result = this.db
      .prepare(
        'UPDATE node_monitor_subscriptions SET active = ?, updated_at = ? WHERE telegram_chat_id = ?',
      )
      .run(active ? 1 : 0, nowIso(), chatId);
    return result.changes > 0;
  }

  close(): void {
    this.db.close();
  }
}

export function createSqliteStorage(path: string, logger: Logger): Storage {
  const db = openSqlite(path, logger);
  const repo = new SqliteNodeMonitorRepo(db);
  logger.info({path}, 'SQLite storage opened');
  return {
    repo,
    close: () => repo.close(),
  };
}
