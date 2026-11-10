import {loadConfig} from '../config';
import {createLogger} from '../logger';
import {createStorage} from '../storage';

/**
 * Idempotent schema migration CLI (`npm run db:migrate`). The service also
 * migrates automatically on startup.
 */
function main(): void {
  const logger = createLogger();
  const config = loadConfig();
  const storage = createStorage(config.storage, logger);
  storage.close();
  logger.info(
    {driver: config.storage.driver, path: config.storage.path},
    'storage is up to date',
  );
}

try {
  main();
} catch (error) {
  console.error(
    'migration failed:',
    error instanceof Error ? error.message : String(error),
  );
  process.exitCode = 1;
}
