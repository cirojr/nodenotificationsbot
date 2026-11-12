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
  path: z.string().min(1).default('data/bot.db'),
});

const ibdMonitorSchema = z.object({
  sampleIntervalSeconds: z.number().int().min(5).max(3_600).default(60),
  progressStepPercent: z.number().int().min(1).max(50).default(10),
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
  }),
  storage: storageSchema.default({path: 'data/bot.db'}),
  ibdMonitor: ibdMonitorSchema.default({
    sampleIntervalSeconds: 60,
    progressStepPercent: 10,
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
  } else if (explicitPath) {
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

const CHAIN_BY_NETWORK: Record<BitcoinNetwork, string> = {
  mainnet: 'main',
  testnet: 'test',
  signet: 'signet',
  regtest: 'regtest',
};

/** Map the configured network name to Bitcoin Core's `chain` field. */
export function networkToChain(network: BitcoinNetwork): string {
  return CHAIN_BY_NETWORK[network];
}
