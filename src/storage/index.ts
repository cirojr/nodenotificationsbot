import type {Logger} from '../logger';
import {createSqliteStorage} from './monitoredChatRepo';

export type MonitorState = 'unknown' | 'ibd' | 'synced' | 'unreachable';

export interface MonitoredChat {
  chatId: number;
  lastState: MonitorState;
  lastSentBucket: number | null;
  createdAt: string;
}

export interface MonitoredChatPatch {
  lastState?: MonitorState;
  lastSentBucket?: number | null;
}

export interface MonitoredChatRepo {
  list(): MonitoredChat[];
  get(chatId: number): MonitoredChat | null;
  add(chatId: number): void;
  update(chatId: number, patch: MonitoredChatPatch): void;
  remove(chatId: number): boolean;
  close(): void;
}

export interface Storage {
  chats: MonitoredChatRepo;
  close(): void;
}

export function createStorage(path: string, logger: Logger): Storage {
  return createSqliteStorage(path, logger);
}
