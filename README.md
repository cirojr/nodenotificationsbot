# NodeNotificationsBot — v0.1 (IBD monitor)

Telegram bot that reports the **initial block download (IBD)** progress of a local
**Bitcoin Core** node. v0.1 is intentionally read-only: it uses a fixed set of RPC
methods (`getblockchaininfo`, `getnetworkinfo`, `getblockheader`, optional
`getchainstates`), persists subscriptions in SQLite, and sends percentage-triggered
Telegram updates.

## Commands

| Command | Description |
|---|---|
| `/start`, `/help` | Usage |
| `/ibd` | One-shot node sync snapshot (cached for 30 s) |
| `/ibd watch [step]` | Subscribe to updates every `step` percent (default 10, range 1–50) |
| `/ibd status` | Subscription settings + current snapshot |
| `/ibd stop` | Stop updates |

Progress updates are **percentage-triggered**: with the default step, the user gets a
message at 10%, 20%, 30%, … plus a final message when IBD finishes. A shared sampler
runs every `sampleIntervalSeconds`, so a crossing is noticed within about a minute.
State-change alerts (stalled, regressed/reindex, unreachable, recovered) are sent once
per episode and debounced by `minAlertIntervalSeconds`.

## Requirements

- Node.js **≥ 22** (tested on Node 24); `better-sqlite3` ships prebuilt binaries for
  common platforms.
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
rpcwhitelist=nodenotificationsbot:getblockchaininfo,getnetworkinfo,getblockheader,getchainstates
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
2. an optional `rpcwhitelist=...` block for the read-only methods the bot uses;
3. `BITCOIN_RPC_USER` / `BITCOIN_RPC_PASSWORD` for the bot.

The printed password is the only copy of the plaintext: the hash cannot be
turned back into it. The bot never reads `bitcoin.conf` or computes the hash; it
only sends `user:password` over Basic auth. To supply your own password instead
of a generated one, pipe it in with `--password-stdin`.

`rpcwhitelistdefault=0` restricts only the listed user. On a dedicated node, set
it to `1` to deny every user that is not explicitly listed. Bitcoin Core returns
`-32601` for non-whitelisted methods; the client already treats that as "method
unavailable" for `getchainstates`.

If you are upgrading from a cookie-based setup, remove `cookieFile` /
`BITCOIN_RPC_COOKIE_FILE` and add the `user`/`password` pair. The service now
refuses to start without it.

Verify on the host:

```bash
bitcoin-cli -getinfo
bitcoin-cli getblockchaininfo | jq '{chain,blocks,headers,verificationprogress,initialblockdownload}'
bitcoin-cli getnetworkinfo | jq '{connections,connections_in,connections_out,warnings}'
bitcoin-cli getchainstates 2>/dev/null || echo "getchainstates unavailable (Core < 26)"
```

The service calls the JSON-RPC methods directly; `-getinfo` is only a human check.

## Setup

```bash
npm ci
npm run rpc:auth -- nodenotificationsbot   # append rpcauth= to bitcoin.conf
cp config/config.example.yaml config/config.yaml
$EDITOR config/config.yaml          # token, RPC user/password, storage path

npm run db:migrate                  # idempotent; also runs automatically on startup
npm run build
npm start
```

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

`bitcoin.rpc.user` and `bitcoin.rpc.password` are required; there is no
cookie-file mode.

Important settings (`ibdMonitor`):

| Setting | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Start the shared sampler; `/ibd` commands also reply disabled when off |
| `sampleIntervalSeconds` | `60` | Shared RPC sampling loop |
| `defaultProgressStepPercent` | `10` | Default `/ibd watch` step |
| `min`/`maxProgressStepPercent` | `1` / `50` | Allowed step range |
| `heartbeatMinutes` | `0` | `0` = purely progress-driven |
| `stallMinutes` | `15` | No blocks/headers (or zero peers) for this long → stall alert |
| `reorgTolerance` | `12` | Height drop above this → regressed/reindex alert |
| `unreachableAlertAfterMinutes` | `5` | RPC failure duration before the subscriber alert |
| `minAlertIntervalSeconds` | `300` | State-change message debounce (completion is immediate) |
| `stopAfterSyncMinutes` | `60` | Auto-stop a synced subscription; `0` keeps it |
| `maxSubscriptions` | `5` | Server-wide cap on active subscriptions |
| `allowedChatIds` | `["*"]` | `"*"` = public; empty = nobody allowed |
| `speedWindowMinutes` | `15` | Speed/ETA averaging window |
| `commandThrottleSeconds` | `3` | Per-chat cooldown for `/ibd` (except `/ibd stop`) |

At startup the service calls `getblockchaininfo` and refuses to start if `chain` does
not match `bitcoin.network` (`mainnet → main`, `testnet → test`, `signet`, `regtest`).
If the node is simply down, startup continues and the monitor reports unreachable.

## Storage

SQLite lives in one file with WAL, `busy_timeout`, and `synchronous=NORMAL`;
the service creates the parent directory with mode `0700` and the DB file with `0600`
(systemd also uses `UMask=0077`). Migrations are embedded in the binary and tracked by
`PRAGMA user_version`.

```bash
npm run db:migrate
sqlite3 /var/lib/nodenotificationsbot/bot.db ".backup '/var/lib/nodenotificationsbot/bot.db.bak'"
# or, while stopped: sqlite3 bot.db "VACUUM INTO '/path/bot.db.bak'"
```

Schema (v0.1): `node_monitor_subscriptions`, keyed by Telegram chat id, one row per
user. The `maxSubscriptions` cap is enforced in the service.

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

Rollback: `/ibd stop` for subscribers, or set `ibdMonitor.enabled: false` and restart.
Stop the service before restoring the DB file.

### Smoke test / ship gate

1. `/ibd` matches `bitcoin-cli getblockchaininfo` (`blocks`, `headers`,
   `verificationprogress`, `initialblockdownload`).
2. `/ibd watch 5` creates a row, sends a snapshot, and `last_sent_progress` is set
   after one tick.
3. Wait for a step crossing; confirm HTML `<pre>` alignment, grouped numbers and UTC
   timestamps.
4. `/ibd stop` sets `active = false` and stops messages.
5. Failure drill: stop `bitcoind`; `/ibd` replies "node unreachable" without crashing;
   restart it and confirm the "reachable again" message. On testnet/regtest, pause the
   network (`setnetworkactive false`) to see the stall alert fire once and clear.
6. Restart the service; no duplicate completion/progress messages for state already
   persisted.

## Development and tests

```bash
npm test              # vitest: unit + RPC integration against a fake HTTP server
npm run typecheck
npm run build
```

Test coverage includes: config validation/env overrides, rpcauth generation and
parsing, progress-step and ETA math, speed ring buffer, RPC
auth/timeouts/error mapping, SQLite storage, snapshot/event formatting (HTML
escaping, fresh node, synced, assumeutxo), and the monitor state machine with a
fake clock, fake RPC sampler and mocked Telegram sender.

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

- RPC stays on loopback; the bot uses a dedicated `rpcauth` user (optionally
  method-restricted with `rpcwhitelist`). Errors forwarded to Telegram are
  sanitized and credentials are never logged.
- The monitor is not an RPC proxy: no method names or parameters come from Telegram.
  `allowedChatIds`, the per-chat throttle and `maxSubscriptions` are the abuse controls.

## Troubleshooting

- **`RPC authentication failed (401)`** — check `bitcoin.rpc.user` and
  `bitcoin.rpc.password` against the `rpcauth=` line in `bitcoin.conf`. If the
  plaintext password was lost, generate a new pair with `npm run rpc:auth` and
  update both sides. The bot does not read the cookie file.
- **`node chain is "test" but config expects mainnet`** — fix `bitcoin.network`; the
  service refuses to run against the wrong chain.
- **Bot silent after deploy** — check `journalctl`; a bad token fails `bot.start()`.
  Verify `CONFIG_PATH` and `EnvironmentFile`.
- **SQLite `SQLITE_BUSY`** — another process owns the file; v0.1 assumes a single
  instance (`PLAN.md` A4) and sets `busy_timeout=5000`.

## Roadmap

v0.2 adds ZMQ `hashblock` + `BlockProcessor.sync()` (RPC is the source of truth),
`/watch`/`/list`/`/cancel`, the outbox notifier with retries and blocked-user
handling, and a PostgreSQL migration decision. See `PLAN.md`.
