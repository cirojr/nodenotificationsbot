import {existsSync, readFileSync} from 'node:fs';
import {parse as parseYaml} from 'yaml';
import {z} from 'zod';

const networkSchema = z.enum(['mainnet', 'testnet', 'signet', 'regtest']);
export type BitcoinNetwork = z.infer<typeof networkSchema>;

const rpcSchema = z
  .strictObject({
    url: z.url().default('http://127.0.0.1:8332'),
    user: z.string().min(1).optional(),
    password: z.string().min(1).optional(),
    timeoutMs: z.number().int().min(500).max(60_000).default(5_000),
  })
  .superRefine((rpc, ctx) => {
    if (!rpc.user || !rpc.password) {
      ctx.addIssue({
        code: 'custom',
        path: ['user'],
        message:
          'bitcoin.rpc needs both user and password from an rpcauth credential (env: BITCOIN_RPC_USER + BITCOIN_RPC_PASSWORD); cookie auth is no longer supported',
      });
    }
  });

const storageSchema = z.object({
  driver: z.literal('sqlite').default('sqlite'),
  path: z.string().min(1).default('data/bot.db'),
});

const watchesSchema = z.object({
  defaultConfirmations: z.number().int().min(1).max(100).default(1),
  maxConfirmations: z.number().int().min(1).max(100).default(6),
  maxActivePerUser: z.number().int().min(1).default(20),
  expireAfterDays: z.number().int().min(0).default(14),
});

const ibdMonitorSchema = z
  .object({
    enabled: z.boolean().default(true),
    sampleIntervalSeconds: z.number().int().min(5).max(3_600).default(60),
    defaultProgressStepPercent: z.number().int().min(1).max(50).default(10),
    minProgressStepPercent: z.number().int().min(1).max(50).default(1),
    maxProgressStepPercent: z.number().int().min(1).max(50).default(50),
    heartbeatMinutes: z.number().int().min(0).max(1_440).default(0),
    stallMinutes: z.number().int().min(1).max(1_440).default(15),
    reorgTolerance: z.number().int().min(0).max(10_000).default(12),
    unreachableAlertAfterMinutes: z.number().int().min(1).max(1_440).default(5),
    minAlertIntervalSeconds: z.number().int().min(0).max(86_400).default(300),
    stopAfterSyncMinutes: z.number().int().min(0).max(10_080).default(60),
    maxSubscriptions: z.number().int().min(1).max(1_000).default(5),
    allowedChatIds: z
      .array(
        z.union([
          z.literal('*'),
          z.number().int(),
          z.string().regex(/^-?\d+$/, 'expected a numeric chat id'),
        ]),
      )
      .default(['*']),
    speedWindowMinutes: z.number().int().min(2).max(240).default(15),
    commandThrottleSeconds: z.number().int().min(0).max(3_600).default(3),
  })
  .superRefine((monitor, ctx) => {
    if (monitor.minProgressStepPercent > monitor.maxProgressStepPercent) {
      ctx.addIssue({
        code: 'custom',
        path: ['minProgressStepPercent'],
        message: 'minProgressStepPercent must be <= maxProgressStepPercent',
      });
    }
    if (
      monitor.defaultProgressStepPercent < monitor.minProgressStepPercent ||
      monitor.defaultProgressStepPercent > monitor.maxProgressStepPercent
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['defaultProgressStepPercent'],
        message: 'defaultProgressStepPercent must be within the min/max range',
      });
    }
  });

export const configSchema = z.object({
  telegram: z.object({
    botToken: z
      .string()
      .min(1, 'telegram.botToken is required (or set TELEGRAM_BOT_TOKEN)')
      .refine(
        token => token !== '123456:ABC...',
        'replace the placeholder bot token',
      ),
  }),
  bitcoin: z.object({
    network: networkSchema.default('mainnet'),
    rpc: rpcSchema,
    pollIntervalSeconds: z.number().int().min(5).default(60),
  }),
  storage: storageSchema.default({driver: 'sqlite', path: 'data/bot.db'}),
  // Reserved for v0.2 tx watching; accepted so configs can be prepared early.
  watches: watchesSchema.default({
    defaultConfirmations: 1,
    maxConfirmations: 6,
    maxActivePerUser: 20,
    expireAfterDays: 14,
  }),
  ibdMonitor: ibdMonitorSchema.default({
    enabled: true,
    sampleIntervalSeconds: 60,
    defaultProgressStepPercent: 10,
    minProgressStepPercent: 1,
    maxProgressStepPercent: 50,
    heartbeatMinutes: 0,
    stallMinutes: 15,
    reorgTolerance: 12,
    unreachableAlertAfterMinutes: 5,
    minAlertIntervalSeconds: 300,
    stopAfterSyncMinutes: 60,
    maxSubscriptions: 5,
    allowedChatIds: ['*'],
    speedWindowMinutes: 15,
    commandThrottleSeconds: 3,
  }),
});

export type AppConfig = z.infer<typeof configSchema>;
export type IbdMonitorConfig = AppConfig['ibdMonitor'];

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

type PlainObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is PlainObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepMerge(base: PlainObject, override: PlainObject): PlainObject {
  const result: PlainObject = {...base};
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) {
      continue;
    }
    const existing = result[key];
    if (isPlainObject(existing) && isPlainObject(value)) {
      result[key] = deepMerge(existing, value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

function envOverrides(env: NodeJS.ProcessEnv): PlainObject {
  const overrides: PlainObject = {};

  const telegram: PlainObject = {};
  if (env.TELEGRAM_BOT_TOKEN) {
    telegram.botToken = env.TELEGRAM_BOT_TOKEN;
  }
  if (Object.keys(telegram).length > 0) {
    overrides.telegram = telegram;
  }

  const rpc: PlainObject = {};
  if (env.BITCOIN_RPC_URL) {
    rpc.url = env.BITCOIN_RPC_URL;
  }
  if (env.BITCOIN_RPC_USER) {
    rpc.user = env.BITCOIN_RPC_USER;
  }
  if (env.BITCOIN_RPC_PASSWORD) {
    rpc.password = env.BITCOIN_RPC_PASSWORD;
  }
  if (Object.keys(rpc).length > 0) {
    overrides.bitcoin = {rpc};
  }

  if (env.STORAGE_PATH) {
    overrides.storage = {path: env.STORAGE_PATH};
  }

  return overrides;
}

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map(issue => {
      const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
      return `  - ${path}: ${issue.message}`;
    })
    .join('\n');
}

export interface LoadConfigOptions {
  /** Defaults to CONFIG_PATH env var or ./config/config.yaml. */
  path?: string;
  env?: NodeJS.ProcessEnv;
  /** When true, a missing config file is an error. */
  requireFile?: boolean;
}

export function loadConfig(options: LoadConfigOptions = {}): AppConfig {
  const env = options.env ?? process.env;
  const explicitPath = options.path ?? env.CONFIG_PATH;
  const configPath = explicitPath ?? 'config/config.yaml';

  let fileConfig: PlainObject = {};
  if (existsSync(configPath)) {
    let raw: unknown;
    try {
      raw = parseYaml(readFileSync(configPath, 'utf8'));
    } catch (error) {
      throw new ConfigError(
        `failed to read config file ${configPath}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (raw === null || raw === undefined) {
      fileConfig = {};
    } else if (!isPlainObject(raw)) {
      throw new ConfigError(
        `config file ${configPath} must contain a YAML mapping at the top level`,
      );
    } else {
      fileConfig = raw;
    }
  } else if (explicitPath || options.requireFile) {
    throw new ConfigError(`config file not found: ${configPath}`);
  }

  const merged = deepMerge(fileConfig, envOverrides(env));
  const parsed = configSchema.safeParse(merged);
  if (!parsed.success) {
    throw new ConfigError(
      `invalid configuration (${configPath}):\n${formatIssues(parsed.error)}`,
    );
  }
  return parsed.data;
}

/** Map the configured network name to Bitcoin Core's `chain` field. */
export function networkToChain(network: BitcoinNetwork): string {
  switch (network) {
    case 'mainnet':
      return 'main';
    case 'testnet':
      return 'test';
    case 'signet':
      return 'signet';
    case 'regtest':
      return 'regtest';
  }
}
