import {readFileSync} from 'node:fs';
import {generateRpcauth, type RpcauthCredential} from '../bitcoin/rpcauth';

const DEFAULT_USER = 'nodenotificationsbot';

interface CliOptions {
  user: string;
  passwordFromStdin: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    user: DEFAULT_USER,
    passwordFromStdin: false,
    help: false,
  };
  const positional: string[] = [];
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--password-stdin') {
      options.passwordFromStdin = true;
    } else if (arg.startsWith('-')) {
      throw new Error(`unknown option: ${arg}`);
    } else {
      positional.push(arg);
    }
  }
  if (positional.length > 1) {
    throw new Error('expected at most one username argument');
  }
  const user = positional[0];
  if (user !== undefined) {
    options.user = user;
  }
  return options;
}

function readPasswordFromStdin(): string {
  return readFileSync(0, 'utf8').replace(/\r?\n$/, '');
}

function printHelp(): void {
  console.log(`Usage: npm run rpc:auth -- [user] [--password-stdin]

Generates a Bitcoin Core rpcauth credential pair. The rpcauth line goes to
bitcoin.conf; the password goes to the bot's environment (mode 0600) or config.

Options:
  --password-stdin  Read the password from stdin instead of generating one.
  -h, --help        Show this help.`);
}

function printCredential(credential: RpcauthCredential): void {
  console.log(`Generated rpcauth credential for "${credential.user}".

1. Append to bitcoin.conf (server side):
${credential.line}

2. Optional: restrict this RPC user to the read-only methods the bot uses:
rpcwhitelist=${credential.user}:getblockchaininfo,getnetworkinfo
rpcwhitelistdefault=0
# rpcwhitelistdefault=0 restricts only the user above. On a dedicated node,
# set it to 1 to deny every RPC user that is not listed.

3. Put these in /etc/nodenotificationsbot/env (mode 0600) or config.yaml:
BITCOIN_RPC_USER=${credential.user}
BITCOIN_RPC_PASSWORD=${credential.password}

Restart bitcoind, then the bot. Keep the password secret: the hash in
bitcoin.conf cannot be turned back into it.`);
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  const credential = options.passwordFromStdin
    ? generateRpcauth(options.user, readPasswordFromStdin())
    : generateRpcauth(options.user);
  printCredential(credential);
}

try {
  main();
} catch (error) {
  console.error(
    'rpc:auth failed:',
    error instanceof Error ? error.message : String(error),
  );
  process.exitCode = 1;
}
