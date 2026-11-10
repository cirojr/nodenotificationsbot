# NodeNotificationsBot — Future Plans

v0.1, the read-only **IBD monitor**, is implemented and documented in `README.md`.
This file tracks only work that is still outstanding: v0.2 transaction
notifications and a short list of optional follow-ups.

## Status

| Area | State |
|---|---|
| v0.1 IBD monitor (`/ibd`, `/ibd watch`, `/ibd status`, `/ibd stop`) | Shipped |
| SQLite storage + migrations, rpcauth tooling, systemd unit | Shipped |
| v0.2 tx notifications (ZMQ + `/watch`) | Not started |
| PostgreSQL | Deferred until scale/operations require it |
| Prometheus metrics | Optional, not started |

The existing foundation to build on: config loader (zod), pino logger, JSON-RPC
client with `rpcauth` Basic auth, SQLite repository/migration runner, grammY bot
with auto-retry and throttling, the shared IBD sampler/state machine, and the
systemd deployment unit. None of those need to be redesigned for v0.2.

---

## 1. v0.2 — Transaction notifications

### 1.1 Goal and scope

Let users register a Bitcoin **mainnet** transaction id (txid) and receive a
Telegram message once the transaction reaches the required number of
confirmations.

- Users submit txids through the bot: `/watch <txid> [confs]`.
- ZMQ `hashblock` is only a trigger; Bitcoin Core RPC is the source of truth.
- ZMQ messages can be missed while the service is down, so a periodic
  `sync()` and a full catch-up on startup are required.
- SQLite remains the storage backend. PostgreSQL is not part of v0.2 unless the
  deferred decision in §1.2 changes that.
- The v0.1 IBD monitor keeps working unchanged.

### 1.2 Open decisions

These questions are still unresolved and should be settled before the affected
work starts.

| # | Question | Current default until decided |
|---|---|---|
| 1 | Should txids also be submitted through an HTTP API, or only Telegram? | Telegram-only. |
| 2 | Default confirmation count: 1, 3 or 6? | `1`, overridable per watch. |
| 3 | Is `txindex=1` enabled (or acceptable) on the production node? | Optional; validation degrades gracefully without it. |
| 5 | Send a notification when the tx first appears in the mempool? | No; confirmation only. |
| 12 | What would trigger a PostgreSQL migration? | Deferred; SQLite stays until single-instance/ops limits are hit. |

Decisions already made that constrain v0.2: the bot is public and users are
identified by Telegram `chat_id`; confirmations are configurable per watch
(while the default remains Q2); the production node does not use assumeutxo;
and subscriptions are persisted.

### 1.3 Architecture

```
                ┌───────────────────────────── nodenotificationsbot ─────────────────────────────┐
  Telegram  ◄──► │  Bot (grammY)  ──► WatchService ──► Repository ──► SQLite                       │
  users         │                         ▲                  ▲                                     │
                │                         │                  │                                     │
                │  ZMQ subscriber ──► BlockProcessor ────────┘                                     │
                │  (hashblock)            │                                                        │
                │                         ▼                                                        │
                │                   Bitcoin RPC client ──► Notifier (Telegram sendMessage)         │
                └────────────────────────────┬────────────────────────────────────────────────────┘
                                             │ ZMQ tcp://127.0.0.1:28332 + JSON-RPC 127.0.0.1:8332
                                       ┌─────▼──────┐
                                       │ bitcoind   │
                                       └────────────┘
```

`IbdMonitor` and the tx-watch pipeline share the RPC client but keep independent
error handling and lifecycles.

### 1.4 Watch lifecycle

```
            /watch                 tx seen in block            confirmations >= N        sent OK
 (none) ───────────► PENDING ───────────────────► IN_BLOCK ───────────────────► CONFIRMED ───────► NOTIFIED
                        │  ▲                          │
                        │  └──── reorg removes block ─┘
                        ├── /cancel ──► CANCELLED
                        └── age > expireAfterDays ──► EXPIRED  (user is notified)
```

### 1.5 Block processing (`BlockProcessor.sync()`)

Serialized: one run at a time; a trigger received while running sets a
"run again" flag.

1. `tip = getblockcount()`; read `chain_state.last_height / last_hash`.
2. **Reorg check**: if `getblockhash(last_height) !== last_hash`, walk back
   until hashes match. For watches with `block_height > fork_height`, reset to
   `PENDING` and clear the block info. If a `NOTIFIED` watch's block was
   orphaned, send a rare "reorg" heads-up.
3. For each height `h` in `(last_height, tip]`:
   - `getblock(hash, 1)` → list of txids.
   - Match against the set of `PENDING` txids (load into a `Set` once per sync;
     the set is small).
   - Matched → `IN_BLOCK` with `block_hash` and `block_height`.
   - Update `chain_state` in the **same DB transaction** as the watch updates.
4. For all `IN_BLOCK` watches: `confs = tip - block_height + 1`; if
   `confs >= required_confirmations` → `CONFIRMED`.
5. Hand `CONFIRMED` rows to the notifier.

On the first ever start, initialize `chain_state` to the current tip; do not
scan history.

### 1.6 Notifier (outbox style)

- Select `CONFIRMED` rows, send the Telegram message, then mark `NOTIFIED`
  (and set `notified_at`).
- On transient errors (429/network): retry with backoff; the row stays
  `CONFIRMED` and is retried on the next sync.
- On `403 Forbidden` (user blocked the bot): mark `NOTIFIED`/`FAILED` and set
  `users.blocked = true`.
- Message example:

  > ✅ Transaction `abcd…1234` is confirmed!
  > Block #915,432 · 1 confirmation
  > https://mempool.space/tx/<txid>

### 1.7 Validating a new watch (`/watch <txid>`)

1. Syntax: `/^[0-9a-fA-F]{64}$/`, normalized to lowercase.
2. Duplicate check (same user + txid active) and per-user limit.
3. Lookup state through RPC:
   - `getmempoolentry(txid)` succeeds → "Seen in mempool, I'll notify you when
     confirmed."
   - Else, if `txindex` is enabled: `getrawtransaction(txid, true)`. If it has a
     `blockhash`, compute confirmations; either notify immediately or store as
     `IN_BLOCK`.
   - Else → accept as `PENDING` with a warning: "Not in my mempool yet (may not
     be broadcast)."
4. Insert the row and reply to the user.

### 1.8 Telegram commands

| Command | Description |
|---|---|
| `/watch <txid> [confs]` | Start watching (a bare 64-hex message is treated as `/watch`) |
| `/list` | Show active watches with status/confirmations |
| `/cancel <txid>` | Stop watching |
| `/status` | Admin: node height, last ZMQ event, pending count |

The existing `/start`, `/help` and `/ibd …` commands stay as they are.

### 1.9 Configuration additions

The current config schema already accepts `bitcoin.pollIntervalSeconds` and the
`watches` block as reserved fields; v0.2 will start consuming them.

```yaml
bitcoin:
  zmq:
    hashBlock: "tcp://127.0.0.1:28332"
  pollIntervalSeconds: 60        # fallback sync when ZMQ is silent

watches:
  defaultConfirmations: 1
  maxConfirmations: 6
  maxActivePerUser: 20
  expireAfterDays: 14            # pending watches older than this expire
```

`bitcoin.conf` additions:

```ini
zmqpubhashblock=tcp://127.0.0.1:28332
# optional but recommended; lets the bot detect already-confirmed txs:
txindex=1
```

The ZMQ endpoint stays loopback-only, like RPC.

### 1.10 Storage changes

Add the following SQLite tables in a new migration; leave the existing
`node_monitor_subscriptions` table keyed by `telegram_chat_id` so v0.1 data needs
no rewrite.

```sql
CREATE TABLE IF NOT EXISTS users (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_chat_id  INTEGER NOT NULL UNIQUE,
  telegram_username TEXT,
  blocked           INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS watches (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id                INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  txid                   TEXT NOT NULL,
  required_confirmations INTEGER NOT NULL DEFAULT 1
                           CHECK (required_confirmations BETWEEN 1 AND 100),
  status                 TEXT NOT NULL DEFAULT 'pending'
                           CHECK (status IN ('pending','in_block','confirmed','notified','cancelled','expired','failed')),
  block_hash             TEXT,
  block_height           INTEGER,
  created_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  confirmed_at           TEXT,
  notified_at            TEXT
);

-- one active watch per user/tx
CREATE UNIQUE INDEX IF NOT EXISTS watches_user_txid_active
  ON watches (user_id, txid) WHERE status IN ('pending', 'in_block', 'confirmed');
CREATE INDEX IF NOT EXISTS watches_status ON watches (status);
CREATE INDEX IF NOT EXISTS watches_txid ON watches (txid);

CREATE TABLE IF NOT EXISTS chain_state (
  id          INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  last_height INTEGER NOT NULL,
  last_hash   TEXT NOT NULL,
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
```

Use repository interfaces (`UserRepo`, `WatchRepo`, `ChainStateRepo`) so the
storage driver remains a config detail.

#### Deferred PostgreSQL target

Only migrate when multiple instances or larger data require it. The target
schema normalizes subscriptions to `user_id`:

```sql
CREATE TABLE users (
  id                BIGSERIAL PRIMARY KEY,
  telegram_chat_id  BIGINT NOT NULL UNIQUE,
  telegram_username TEXT,
  blocked           BOOLEAN NOT NULL DEFAULT false,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TYPE watch_status AS ENUM
  ('pending', 'in_block', 'confirmed', 'notified', 'cancelled', 'expired', 'failed');

CREATE TABLE watches (
  id                     BIGSERIAL PRIMARY KEY,
  user_id                BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  txid                   CHAR(64) NOT NULL,
  required_confirmations SMALLINT NOT NULL DEFAULT 1
                           CHECK (required_confirmations BETWEEN 1 AND 100),
  status                 watch_status NOT NULL DEFAULT 'pending',
  block_hash             CHAR(64),
  block_height           INTEGER,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  confirmed_at           TIMESTAMPTZ,
  notified_at            TIMESTAMPTZ
);

CREATE UNIQUE INDEX watches_user_txid_active
  ON watches (user_id, txid) WHERE status IN ('pending', 'in_block', 'confirmed');
CREATE INDEX watches_status ON watches (status);
CREATE INDEX watches_txid ON watches (txid);

CREATE TABLE chain_state (
  id          SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  last_height INTEGER NOT NULL,
  last_hash   CHAR(64) NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE node_monitor_subscriptions (
  id                    BIGSERIAL PRIMARY KEY,
  user_id               BIGINT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  progress_step_percent SMALLINT NOT NULL DEFAULT 10
                          CHECK (progress_step_percent BETWEEN 1 AND 50),
  active                BOOLEAN NOT NULL DEFAULT true,
  last_state            TEXT NOT NULL DEFAULT 'unknown'
                          CHECK (last_state IN ('unknown','ibd','synced','stalled','regressed','unreachable')),
  last_sent_progress    DOUBLE PRECISION,
  last_progress_bucket  INTEGER,
  last_sent_at          TIMESTAMPTZ,
  last_alert_at         TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX node_monitor_subscriptions_active
  ON node_monitor_subscriptions (active) WHERE active;
```

Sample history stays in memory for ETA. Add a `node_monitor_samples` table only
if historical dashboards are wanted later.

### 1.11 Tests and acceptance

- **Unit**: watch lifecycle, confirmation math, reorg handling, expiry,
  duplicate/per-user limits, notifier retry/403 behavior, message formatting.
- **Integration (regtest)**: create a tx → `/watch` → `generatetoaddress` →
  assert the notification; reorg with `invalidateblock` and confirm the watch
  returns to `PENDING`; restart the service and confirm no duplicate sends.
- **Failure drills**: stop/restart `bitcoind`, drop ZMQ while the service is
  down and confirm the periodic sync catches up.
- **Acceptance**: a real mainnet tx reaches the configured confirmation count
  and produces exactly one notification.

### 1.12 Milestones

1. **Tx-watch foundation** — ZMQ listener, `BlockProcessor.sync()` with
   catch-up/reorg handling, `users`/`watches`/`chain_state` tables.
2. **Telegram watch commands** — `/watch`, `/list`, `/cancel`, watch validation
   through mempool/`txindex`.
3. **Notifier** — outbox processing, retries, blocked-user handling, expiry job.
4. **Integration tests** — regtest happy path and reorg/restart cases.
5. **PostgreSQL decision + deploy** — keep SQLite if single-instance is enough;
   migrate only if scale/operations require it.

---

## 2. Optional follow-ups

These are not required for v0.2 and can be scheduled independently.

- **Prometheus metrics for the IBD monitor**: `ibd_blocks`, `ibd_headers`,
  `ibd_progress`, `ibd_peers`, `ibd_stalled_total`, `ibd_rpc_errors_total`.
  Logging already covers per-sample and state-transition events.
- **Assumeutxo completion guard**: `isNodeSynced()` currently follows decision
  Q7 and does not wait for background validation. If the production node ever
  starts using assumeutxo, completion must require the background chainstate's
  `validated: true` (and the active chain at the tip).
- **Stronger regression detection**: the monitor currently detects a reindex
  from a block-height drop greater than `reorgTolerance`. If needed, also
  compare `bestblockhash` against a much lower height.
- **Production acceptance on testnet/pruned mainnet**: a full IBD run with a
  deliberate `bitcoind` restart and `setnetworkactive false` stall, if that has
  not already been done on the target node.
- **Golden-file message fixtures**: the formatting tests currently assert
  substrings; snapshot/golden files would catch accidental layout changes.

---

## 3. Deployment notes for v0.2

- Keep the existing systemd unit; add the ZMQ endpoint and optional `txindex`
  to `bitcoin.conf`, then restart `bitcoind`.
- Add `bitcoin.zmq` and wire up the already-reserved `watches` block. The
  defaults in `config/config.example.yaml` should be updated at the same time.
- SQLite migrations run automatically on startup (`PRAGMA user_version`). Back
  up with `VACUUM INTO` or `sqlite3 .backup` before deploying the migration.
- Rollback: `/cancel` active watches, stop the service, and restore the
  pre-deploy SQLite backup if a schema rollback is needed.
- Never expose the ZMQ or RPC ports; both stay bound to `127.0.0.1`.
