# NodeNotificationsBot — lean IBD monitor

Telegram bot that reports the **initial block download (IBD)** progress of a local
**Bitcoin Core** node. It is intentionally small and read-only: two RPC calls
(`getblockchaininfo` and `getnetworkinfo`), one SQLite table of chat ids, and
percentage-triggered Telegram updates.

## Commands

| Command | Description |
|---|---|
| `/start`, `/help` | Usage |
| `/ibd` | Save this chat, reply with a live node snapshot, and start monitoring |
| `/ibd stop` | Stop monitoring and delete the chat id |

`/ibd` is the subscription: sending it stores the chat id, replies with the
current sample, and enables progress updates for that chat. There is no separate
`watch`/`status` subcommand. With the default step, the chat gets a message at
10%, 20%, 30%, … and a final completion message. The subscription is removed
automatically after completion, so the table normally stays empty or very small.

While at least one chat is subscribed, a single shared sampler polls the node
every `sampleIntervalSeconds` (`getblockchaininfo`, plus best-effort
`getnetworkinfo` for peers and warnings). The sampler does not run when nobody is
subscribed.

Two state-change alerts remain:

- **Unreachable** — sent once per episode on the first failed `getblockchaininfo`.
- **Reachable again** — sent once when sampling succeeds after an outage.

## Requirements

- Node.js **≥ 22** (tested on Node 24); `better-sqlite3` ships prebuilt binaries
  for common platforms.
- Bitcoin Core with RPC enabled. ZMQ and `txindex` are **not** needed.

`bitcoin.conf`:

```ini
server=1
rpcbind=127.0.0.1
rpcallowip=127.0.0.1

# Dedicated bot credential. Generate with:
#   npm run rpc:auth -- nodenotificationsbot
rpcauth=nodenotificationsbot:<salt>$<hash>
# Optional: restrict the bot to the read-only methods it uses.
rpcwhitelist=nodenotificationsbot:getblockchaininfo,getnetworkinfo
rpcwhitelistdefault=0
```

The bot authenticates with HTTP Basic using `bitcoin.rpc.user` and
`bitcoin.rpc.password`. Bitcoin Core stores only the `rpcauth` salt/hash, so the
plaintext password never goes into `bitcoin.conf`; keep it in the service env
file (mode `0600`) or the config file. **Never expose port 8332**: an `rpcauth`
user is still effectively admin unless `rpcwhitelist` restricts it.

### Generating the RPC credential

```bash
npm run rpc:auth -- nodenotificationsbot
```

The command prints three things:

1. the `rpcauth=...` line to append to `bitcoin.conf` (then restart `bitcoind`);
2. an optional `rpcwhitelist=...` block for `getblockchaininfo,getnetworkinfo`;
3. `BITCOIN_RPC_USER` / `BITCOIN_RPC_PASSWORD` for the bot.

The printed password is the only copy of the plaintext: the hash cannot be
turned back into it. The bot never reads `bitcoin.conf` or computes the hash; it
only sends `user:password` over Basic auth. To supply your own password instead
of a generated one, pipe it in with `--password-stdin`.

`rpcwhitelistdefault=0` restricts only the listed user. On a dedicated node, set
it to `1` to deny every user that is not explicitly listed.

There is no cookie-file mode. The service refuses to start without a
`user`/`password` pair.

Verify on the host:

```bash
bitcoin-cli -getinfo
bitcoin-cli getblockchaininfo | jq '{chain,blocks,headers,verificationprogress,initialblockdownload}'
bitcoin-cli getnetworkinfo | jq '{connections,connections_in,connections_out,warnings}'
```

The service calls the JSON-RPC methods directly; `-getinfo` is only a human check.

## Setup

```bash
npm ci
npm run rpc:auth -- nodenotificationsbot   # append rpcauth= to bitcoin.conf
cp config/config.example.yaml config/config.yaml
$EDITOR config/config.yaml          # token, RPC user/password, storage path

npm run build
npm start
```

Migrations run automatically on startup; there is no separate migrate command.
Development: `npm run dev` (tsx watch). Set `LOG_LEVEL=debug` for one log line per
sample.

### Configuration

`CONFIG_PATH` selects the file (default `config/config.yaml`). `config/config.yaml`
is git-ignored; `config/config.example.yaml` is committed.

Secrets can be supplied through the environment instead of the file:

| Variable | Overrides |
|---|---|
| `TELEGRAM_BOT_TOKEN` | `telegram.botToken` |
| `BITCOIN_RPC_URL` | `bitcoin.rpc.url` |
| `BITCOIN_RPC_USER` / `BITCOIN_RPC_PASSWORD` | `bitcoin.rpc.user` / `password` |
| `STORAGE_PATH` | `storage.path` |
| `CONFIG_PATH` | Config file path |
| `LOG_LEVEL` | Log level (default `info`) |

`bitcoin.rpc.user` and `bitcoin.rpc.password` are required.

Settings (`ibdMonitor`):

| Setting | Default | Meaning |
|---|---|---|
| `sampleIntervalSeconds` | `60` | Shared RPC sampling loop |
| `progressStepPercent` | `10` | Notify every N percent of verification progress |

At startup the service calls `getblockchaininfo` and refuses to start if `chain`
does not match `bitcoin.network` (`mainnet → main`, `testnet → test`, `signet`,
`regtest`). If the node is simply down, startup continues and the monitor reports
unreachable.

## Storage

SQLite lives in one file with WAL, `busy_timeout`, and `synchronous=NORMAL`;
the service creates the parent directory with mode `0700` and the DB file with
`0600` (systemd also uses `UMask=0077`). Migrations are embedded in the binary and
tracked by `PRAGMA user_version`.

```bash
sqlite3 /var/lib/nodenotificationsbot/bot.db ".backup '/var/lib/nodenotificationsbot/bot.db.bak'"
# or, while stopped: sqlite3 bot.db "VACUUM INTO '/path/bot.db.bak'"
```

Schema (`monitored_chats`): one row per subscribed chat.

```sql
chat_id          INTEGER PRIMARY KEY,
last_state       TEXT NOT NULL DEFAULT 'unknown'
                   CHECK (last_state IN ('unknown','ibd','synced','unreachable')),
last_sent_bucket INTEGER,
created_at       TEXT NOT NULL
```

`last_state` only exists so the monitor can avoid duplicate unreachable alerts
and retry a failed completion message after a restart. Progress history, speed,
ETA, and per-chat step overrides are not persisted (or computed at all).
Migration `v3` drops the old `node_monitor_subscriptions` table; there is no
production data to preserve.

## Deployment

Suggested layout:

```
/opt/nodenotificationsbot           # code + dist + node_modules
/etc/nodenotificationsbot/config.yaml
/etc/nodenotificationsbot/env       # optional secrets, mode 0600
/var/lib/nodenotificationsbot/      # SQLite (StateDirectory)
```

```bash
sudo useradd --system --home /opt/nodenotificationsbot --shell /usr/sbin/nologin nodenotificationsbot
sudo install -d -o nodenotificationsbot -g nodenotificationsbot /opt/nodenotificationsbot
# copy the project, then:
sudo -u nodenotificationsbot npm ci && sudo -u nodenotificationsbot npm run build
sudo install -d -m 0750 -o nodenotificationsbot -g nodenotificationsbot /etc/nodenotificationsbot
sudo install -m 0600 -o nodenotificationsbot -g nodenotificationsbot config/config.yaml /etc/nodenotificationsbot/config.yaml
sudo install -m 0644 deploy/nodenotificationsbot.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now nodenotificationsbot
journalctl -u nodenotificationsbot -f     # expect "ibd monitor started" / "telegram bot started"
```

The unit starts after `bitcoind.service` through a weak `Wants=` dependency, so
stopping bitcoind does not stop the bot. It restarts on failure and uses
`ProtectSystem=strict`, `ProtectHome=true`, `NoNewPrivileges`, `PrivateTmp`, and
`StateDirectory=nodenotificationsbot`. With `rpcauth` there is no cookie file to
read, so `ProtectHome=true` is safe.

Rollback: `/ibd stop` for subscribers, or stop the service. There is no
feature-flag switch anymore; the bot only monitors. Stop the service before
restoring the DB file.

### Smoke test / ship gate

1. `/ibd` matches `bitcoin-cli getblockchaininfo` (`blocks`, `headers`,
   `verificationprogress`, `initialblockdownload`), and a row appears in
   `monitored_chats`.
2. Wait for a step crossing; confirm HTML `<pre>` alignment, grouped numbers and
   UTC timestamps.
3. `/ibd stop` deletes the row and stops messages.
4. Failure drill: stop `bitcoind`; the chat gets one "node unreachable" message;
   restart it and confirm the "reachable again" message. No crash either way.
5. Restart the service; no duplicate progress or completion messages for state
   already persisted.
6. When IBD finishes, the completion message is sent and the row is removed.

## Development and tests

```bash
npm test              # vitest: unit + RPC integration against a fake HTTP server
npm run typecheck
npm run check         # typecheck + lint + formatting
npm run build
```

Test coverage includes: config validation/env overrides, rpcauth generation,
progress-step math, RPC auth/timeouts/error mapping, SQLite storage and
migrations, snapshot/event formatting (HTML escaping, fresh node, synced,
unreachable), and the monitor state machine with a fake sampler and mocked
Telegram sender.

Manual smoke tests run against the Bitcoin Core node already running on the host;
no container is required.

```bash
bitcoin-cli -getinfo
bitcoin-cli getblockchaininfo | jq '{chain,blocks,headers,verificationprogress,initialblockdownload}'
```

Point `bitcoin.network` at that node's chain and keep `bitcoin.rpc.url` on its local
RPC endpoint (the default is `http://127.0.0.1:8332` for mainnet, `18332` for
testnet, `18443` for regtest). Then start the bot with `npm run dev`.

## Security notes

- RPC stays on loopback; the bot uses a dedicated `rpcauth` user restricted with
  `rpcwhitelist` to `getblockchaininfo,getnetworkinfo`. Errors forwarded to
  Telegram are sanitized and credentials are never logged.
- The monitor is not an RPC proxy: no method names or parameters come from
  Telegram. The bot is public: anyone who can message it can subscribe their own
  chat to progress updates. There is no allowlist; the surface is just those two
  read-only RPC calls.

## Troubleshooting

- **`RPC authentication failed (401)`** — check `bitcoin.rpc.user` and
  `bitcoin.rpc.password` against the `rpcauth=` line in `bitcoin.conf`. If the
  plaintext password was lost, generate a new pair with `npm run rpc:auth` and
  update both sides. The bot does not read the cookie file.
- **`Bitcoin node chain is "test" but config expects mainnet`** — fix
  `bitcoin.network`; the service refuses to run against the wrong chain.
- **Bot silent after deploy** — check `journalctl`; a bad token fails `bot.start()`.
  Verify `CONFIG_PATH` and `EnvironmentFile`.
- **SQLite `SQLITE_BUSY`** — another process owns the file; the bot assumes a
  single instance and sets `busy_timeout=5000`.

## Roadmap

`PLAN.md` keeps the v0.2 transaction-notification ideas and a short list of
optional follow-ups.
