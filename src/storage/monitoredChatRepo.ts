import type {Logger} from '../logger';
import type {
  MonitoredChat,
  MonitoredChatPatch,
  MonitoredChatRepo,
  MonitorState,
  Storage,
} from './index';
import {openSqlite, type SqliteDatabase} from './sqlite';

interface ChatRow {
  chat_id: number;
  last_state: string;
  last_sent_bucket: number | null;
  created_at: string;
}

type SqlValue = string | number | null;

function mapRow(row: ChatRow): MonitoredChat {
  return {
    chatId: row.chat_id,
    lastState: row.last_state as MonitorState,
    lastSentBucket: row.last_sent_bucket,
    createdAt: row.created_at,
  };
}

export class SqliteMonitoredChatRepo implements MonitoredChatRepo {
  private readonly db: SqliteDatabase;

  constructor(db: SqliteDatabase) {
    this.db = db;
  }

  list(): MonitoredChat[] {
    const rows = this.db
      .prepare('SELECT * FROM monitored_chats ORDER BY chat_id')
      .all() as ChatRow[];
    return rows.map(mapRow);
  }

  get(chatId: number): MonitoredChat | null {
    const row = this.db
      .prepare('SELECT * FROM monitored_chats WHERE chat_id = ?')
      .get(chatId) as ChatRow | undefined;
    return row ? mapRow(row) : null;
  }

  add(chatId: number): void {
    this.db
      .prepare(
        'INSERT INTO monitored_chats (chat_id) VALUES (?) ON CONFLICT(chat_id) DO NOTHING',
      )
      .run(chatId);
  }

  update(chatId: number, patch: MonitoredChatPatch): void {
    const fields: string[] = [];
    const values: SqlValue[] = [];

    if (patch.lastState !== undefined) {
      fields.push('last_state = ?');
      values.push(patch.lastState);
    }
    if (patch.lastSentBucket !== undefined) {
      fields.push('last_sent_bucket = ?');
      values.push(patch.lastSentBucket);
    }
    if (fields.length === 0) {
      return;
    }

    values.push(chatId);
    this.db
      .prepare(
        `UPDATE monitored_chats SET ${fields.join(', ')} WHERE chat_id = ?`,
      )
      .run(...values);
  }

  remove(chatId: number): boolean {
    const result = this.db
      .prepare('DELETE FROM monitored_chats WHERE chat_id = ?')
      .run(chatId);
    return result.changes > 0;
  }

  close(): void {
    this.db.close();
  }
}

export function createSqliteStorage(path: string, logger: Logger): Storage {
  const db = openSqlite(path, logger);
  const chats = new SqliteMonitoredChatRepo(db);
  logger.info({path}, 'SQLite storage opened');
  return {
    chats,
    close: () => chats.close(),
  };
}
