import {RpcClient, sanitizeRpcError} from './bitcoin/rpcClient';
import {RpcNodeSampler} from './bitcoin/nodeStatus';
import {loadConfig, networkToChain, type AppConfig} from './config';
import {createLogger} from './logger';
import {IbdMonitor} from './services/ibdMonitor';
import {createStorage} from './storage';
import {
  createBot,
  createTelegramSender,
  registerHandlers,
} from './telegram/bot';

async function verifyChain(
  rpc: RpcClient,
  config: AppConfig,
  logger: ReturnType<typeof createLogger>,
): Promise<void> {
  const expectedChain = networkToChain(config.bitcoin.network);
  let info;
  try {
    info = await rpc.getBlockchainInfo();
  } catch (error) {
    logger.warn(
      {error: sanitizeRpcError(error)},
      'could not verify the node chain at startup; the IBD monitor will report it as unreachable',
    );
    return;
  }

  if (info.chain !== expectedChain) {
    throw new Error(
      `Bitcoin node chain is "${info.chain}" but config expects ${config.bitcoin.network} ("${expectedChain}"); refusing to start`,
    );
  }
  logger.info(
    {
      chain: info.chain,
      blocks: info.blocks,
      headers: info.headers,
      ibd: info.initialblockdownload,
    },
    'bitcoin node verified',
  );
}

async function main(): Promise<void> {
  const logger = createLogger();
  const config = loadConfig();

  logger.info(
    {
      network: config.bitcoin.network,
      storage: config.storage.driver,
      ibdMonitorEnabled: config.ibdMonitor.enabled,
    },
    'starting NodeNotificationsBot',
  );

  const storage = createStorage(config.storage, logger);
  let storageClosed = false;
  const closeStorage = (): void => {
    if (storageClosed) {
      return;
    }
    storageClosed = true;
    storage.close();
  };

  const {user, password} = config.bitcoin.rpc;
  if (!user || !password) {
    // Config validation already enforces this; keep the invariant explicit.
    throw new Error('bitcoin.rpc.user and bitcoin.rpc.password are required');
  }
  const rpc = new RpcClient({
    url: config.bitcoin.rpc.url,
    user,
    password,
    timeoutMs: config.bitcoin.rpc.timeoutMs,
  });

  await verifyChain(rpc, config, logger);

  const bot = createBot(config);
  const sender = createTelegramSender(bot);
  const monitor = new IbdMonitor({
    repo: storage.repo,
    sampler: new RpcNodeSampler(rpc, config.bitcoin.rpc.timeoutMs),
    sender,
    config: config.ibdMonitor,
    logger,
    adminChatIds: config.telegram.adminChatIds,
    rpcUrl: config.bitcoin.rpc.url,
  });

  registerHandlers(bot, monitor, config, logger);

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logger.info({signal}, 'shutting down');
    try {
      await monitor.stop();
    } catch (error) {
      logger.error(
        {error: sanitizeRpcError(error)},
        'error while stopping the IBD monitor',
      );
    }
    try {
      await bot.stop();
    } catch (error) {
      logger.error(
        {error: sanitizeRpcError(error)},
        'error while stopping the Telegram bot',
      );
    }
    closeStorage();
    logger.info('shutdown complete');
    // Best effort: don't linger on a stuck in-flight Telegram request.
    process.exit(0);
  };

  process.once('SIGINT', () => {
    void shutdown('SIGINT');
  });
  process.once('SIGTERM', () => {
    void shutdown('SIGTERM');
  });

  if (config.ibdMonitor.enabled) {
    monitor.start();
  } else {
    logger.info('ibd monitor disabled by config');
  }

  try {
    await bot.start({
      allowed_updates: ['message'],
      onStart: info => {
        logger.info(
          {username: info.username},
          'telegram bot started (long polling)',
        );
      },
    });
  } finally {
    if (!shuttingDown) {
      await monitor.stop();
      closeStorage();
    }
  }
}

main().catch((error: unknown) => {
  console.error(
    'fatal startup error:',
    error instanceof Error ? error.message : String(error),
  );
  process.exitCode = 1;
});
