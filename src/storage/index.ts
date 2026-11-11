import type {Logger} from '../logger';
import {createSqliteStorage} from './nodeMonitorRepo';

export type MonitorState =
  'unknown' | 'ibd' | 'synced' | 'stalled' | 'regressed' | 'unreachable';

export const MONITOR_STATES: readonly MonitorState[] = [
  'unknown',
  'ibd',
  'synced',
  'stalled',
  'regressed',
  'unreachable',
];

export interface Subscription {
  id: number;
  telegramChatId: number;
  progressStepPercent: number;
  active: boolean;
  lastState: MonitorState;
  lastSentProgress: number | null;
  lastSentAt: string | null;
  lastAlertAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SubscriptionPatch {
  progressStepPercent?: number;
  active?: boolean;
  lastState?: MonitorState;
  lastSentProgress?: number | null;
  lastSentAt?: string | null;
  lastAlertAt?: string | null;
}

export interface NodeMonitorSubscriptionRepo {
  getByChatId(chatId: number): Subscription | null;
  listActive(): Subscription[];
  countActive(): number;
  create(chatId: number, progressStepPercent: number): Subscription;
  update(chatId: number, patch: SubscriptionPatch): void;
  setActive(chatId: number, active: boolean): boolean;
  close(): void;
}

export interface Storage {
  repo: NodeMonitorSubscriptionRepo;
  close(): void;
}

export interface StorageConfig {
  driver: 'sqlite';
  path: string;
}

export const DEFAULT_PROGRESS_STEP_PERCENT = 10;

export function createStorage(config: StorageConfig, logger: Logger): Storage {
  return createSqliteStorage(config.path, logger);
}
