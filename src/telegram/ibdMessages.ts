import {isNodeSynced, type NodeSample} from '../bitcoin/nodeStatus';
import {
  formatEta,
  nextProgressPercent,
  progressBucket,
} from '../services/progress';

const integerFormatter = new Intl.NumberFormat('en-US', {
  maximumFractionDigits: 0,
});

export interface SnapshotContext {
  stepPercent?: number;
  speedBlocksPerMinute?: number | null;
  speedWindowMinutes?: number;
  etaMinutes?: number | null;
}

export interface SubscriptionStatusView {
  progressStepPercent: number;
  active: boolean;
  lastState: string;
  lastSentProgress: number | null;
  lastSentAt: string | null;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function formatInt(value: number): string {
  if (!Number.isFinite(value)) {
    return '0';
  }
  return integerFormatter.format(Math.trunc(value));
}

function formatGroupedPercent(value: number, digits: number): string {
  if (!Number.isFinite(value)) {
    return '0%';
  }
  return `${value.toFixed(digits)}%`;
}

/** Verification progress with up to 3 decimals, trailing zeros trimmed (88.73%, 99.999%). */
function formatVerification(value: number): string {
  if (!Number.isFinite(value)) {
    return 'unknown';
  }
  return `${(value * 100)
    .toFixed(3)
    .replace(/(\.\d*?)0+$/, '$1')
    .replace(/\.$/, '')}%`;
}

function formatProgress(value: number): string {
  if (!Number.isFinite(value)) {
    return 'unknown';
  }
  return formatGroupedPercent(Math.min(100, Math.max(0, value)), 1);
}

function formatGiB(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '0.0 GiB';
  }
  return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
}

function utcTimestamp(date: Date): string {
  if (!Number.isFinite(date.getTime())) {
    return 'unknown';
  }
  return `${date.toISOString().slice(0, 19).replace('T', ' ')} UTC`;
}

function utcMinute(date: Date): string {
  if (!Number.isFinite(date.getTime())) {
    return 'unknown';
  }
  return `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

function shortHash(hash: string, length = 20): string {
  if (!hash) {
    return '—';
  }
  return hash.length <= length ? hash : `${hash.slice(0, length)}…`;
}

function peersLine(sample: NodeSample): string {
  if (!sample.peers) {
    return 'unknown';
  }
  const inbound =
    sample.peers.inbound === null ? '?' : String(sample.peers.inbound);
  const outbound =
    sample.peers.outbound === null ? '?' : String(sample.peers.outbound);
  return `${formatInt(sample.peers.total)}  (in ${inbound} / out ${outbound})`;
}

function warningsLine(sample: NodeSample): string {
  if (sample.warnings.length === 0) {
    return 'none';
  }
  const joined = sample.warnings.join('; ');
  const trimmed = joined.length > 240 ? `${joined.slice(0, 237)}...` : joined;
  return escapeHtml(trimmed);
}

function tipLine(sample: NodeSample): string {
  if (!sample.bestBlockHash) {
    return '—';
  }
  const hash = shortHash(sample.bestBlockHash);
  if (!sample.bestBlockTime) {
    return hash;
  }
  return `${hash}  (${utcMinute(sample.bestBlockTime)})`;
}

function speedLine(
  sample: NodeSample,
  context: SnapshotContext,
): string | null {
  const speed = context.speedBlocksPerMinute;
  if (speed === undefined || speed === null) {
    return 'collecting samples…';
  }
  const window = Math.max(1, Math.round(context.speedWindowMinutes ?? 15));
  return `${formatInt(Math.round(speed))} blocks/min  (${window} min average)`;
}

function blocksLine(sample: NodeSample): string {
  if (sample.headers <= 0) {
    return `${formatInt(sample.blocks)} / 0  (waiting for headers)`;
  }
  const pct = sample.headers > 0 ? (sample.blocks / sample.headers) * 100 : 0;
  return `${formatInt(sample.blocks)} / ${formatInt(sample.headers)}  (${formatGroupedPercent(pct, 1)})`;
}

function progressFooter(
  sample: NodeSample,
  context: SnapshotContext,
): string[] {
  const step = context.stepPercent;
  if (step === undefined) {
    return [];
  }
  const next = nextProgressPercent(sample.progressPercent, step);
  return [
    `Progress     ${formatProgress(sample.progressPercent)}  (step: every ${step}%)`,
    `Next update  ${next === null ? '—  (waiting for completion)' : `at ${next.toFixed(1)}%`}`,
  ];
}

function assumeUtxoLines(sample: NodeSample): string[] {
  const info = sample.assumeUtxo;
  if (!info) {
    return [];
  }
  const lines: string[] = [];
  const active = info.active;
  lines.push(
    `Active       ${formatInt(active.blocks)} / ${formatInt(active.headers)}  · validated: ${active.validated ? 'yes' : 'no'}`,
  );
  if (info.background) {
    const background = info.background;
    const pct =
      background.headers > 0
        ? (background.blocks / background.headers) * 100
        : 0;
    lines.push(
      `Background   ${formatInt(background.blocks)} / ${formatInt(background.headers)}  (${formatGroupedPercent(pct, 1)})  · validated: ${background.validated ? 'yes' : 'no'}`,
    );
  }
  if (info.snapshotBlockHash) {
    lines.push(`Snapshot     base ${shortHash(info.snapshotBlockHash, 24)}`);
  }
  return lines;
}

export function formatSnapshot(
  sample: NodeSample,
  context: SnapshotContext = {},
): string {
  const synced = isNodeSynced(sample);
  const hasAssumeUtxo = sample.assumeUtxo !== undefined;

  const header = synced
    ? '✅ Node is not in IBD — chain is synced'
    : hasAssumeUtxo
      ? '🟡 Node is catching up (assumeutxo)'
      : '🟡 Node is in IBD (initial block download)';

  const lines: string[] = [];
  lines.push(`Chain        ${escapeHtml(sample.chain)}`);

  if (synced) {
    lines.push(
      `Blocks       ${formatInt(sample.blocks)} / ${formatInt(sample.headers)}  (0 behind)`,
    );
    if (Number.isFinite(sample.verificationProgress)) {
      lines.push(
        `Verified     ${formatVerification(sample.verificationProgress)}`,
      );
    }
    lines.push(...assumeUtxoLines(sample));
  } else if (sample.headers <= 0) {
    lines.push(
      `Blocks       ${formatInt(sample.blocks)} / 0  (waiting for headers)`,
    );
    lines.push('Status       waiting for headers from peers');
  } else if (hasAssumeUtxo) {
    lines.push(...assumeUtxoLines(sample));
    const step = context.stepPercent ?? 10;
    lines.push(
      `Progress     ${formatProgress(sample.progressPercent)}  (step: every ${step}%)`,
    );
    const next = nextProgressPercent(sample.progressPercent, step);
    lines.push(
      `Next update  ${next === null ? '—  (waiting for completion)' : `at ${next.toFixed(1)}%`}`,
    );
    lines.push(`ETA (bg)     ${formatEta(context.etaMinutes ?? null)}`);
  } else {
    lines.push(`Blocks       ${blocksLine(sample)}`);
    lines.push(`Headers      ${formatInt(sample.headers)}`);
    if (Number.isFinite(sample.verificationProgress)) {
      lines.push(
        `Verified     ${formatVerification(sample.verificationProgress)}`,
      );
    }
    const behind = Math.max(0, sample.headers - sample.blocks);
    lines.push(`Remaining    ${formatInt(behind)} blocks`);
    const speed = speedLine(sample, context);
    if (speed !== null) {
      lines.push(`Speed        ${speed}`);
    }
    lines.push(`ETA          ${formatEta(context.etaMinutes ?? null)}`);
    if (Number.isFinite(sample.verificationProgress)) {
      lines.push(...progressFooter(sample, context));
    }
  }

  lines.push(`Tip          ${tipLine(sample)}`);
  lines.push(
    `Disk         ${formatGiB(sample.sizeOnDisk)}  (pruned: ${sample.pruned ? 'yes' : 'no'})`,
  );
  lines.push(`Peers        ${peersLine(sample)}`);
  lines.push(`Warnings     ${warningsLine(sample)}`);
  lines.push(`Sampled      ${utcTimestamp(sample.sampledAt)}`);

  return `${header}\n\n<pre>\n${lines.join('\n')}\n</pre>`;
}

export function formatIbdFinished(sample: NodeSample): string {
  const verified = Number.isFinite(sample.verificationProgress)
    ? `verification ${formatVerification(sample.verificationProgress)}`
    : 'verification unknown';
  const tip = sample.bestBlockHash ? shortHash(sample.bestBlockHash) : '—';
  const time = sample.bestBlockTime
    ? utcMinute(sample.bestBlockTime)
    : utcTimestamp(sample.sampledAt);
  return `✅ IBD finished — node is fully synced\n\n<pre>\nBlocks ${formatInt(sample.blocks)} / ${formatInt(sample.headers)} · ${verified} · tip ${tip} · ${time}\n</pre>`;
}

export function formatStall(
  sample: NodeSample,
  stalledForMinutes: number,
): string {
  const peers = sample.peers ? formatInt(sample.peers.total) : 'unknown';
  const verified = Number.isFinite(sample.verificationProgress)
    ? formatVerification(sample.verificationProgress)
    : 'unknown';
  const minutes = Math.max(1, Math.round(stalledForMinutes));
  return [
    '⚠️ IBD appears stalled',
    '',
    '<pre>',
    `No new blocks for ${minutes} min (last #${formatInt(sample.blocks)}). Peers: ${peers}. Verification: ${verified}.`,
    '</pre>',
    'Check: bitcoin-cli getnetworkinfo · bitcoin-cli getpeerinfo · journalctl -u bitcoind',
  ].join('\n');
}

export function formatRegression(
  previous: NodeSample,
  next: NodeSample,
): string {
  const headersText =
    next.headers === previous.headers
      ? `while headers stayed at ${formatInt(next.headers)}`
      : `while headers are at ${formatInt(next.headers)}`;
  return [
    '🔻 Node regressed / is reindexing',
    '',
    '<pre>',
    `Blocks dropped from ${formatInt(previous.blocks)} to ${formatInt(next.blocks)} ${headersText}. This usually means -reindex or -reindex-chainstate. Monitoring continues; ETA is paused until progress resumes.`,
    '</pre>',
  ].join('\n');
}

export function formatUnreachable(
  rpcLabel: string,
  error: string,
  retrySeconds: number,
): string {
  const sanitized = error.replace(/\s+/g, ' ').trim().replace(/[.]+$/, '');
  return [
    '🔌 Node unreachable',
    '',
    '<pre>',
    `${escapeHtml(`RPC at ${rpcLabel} did not answer: ${sanitized}. I will keep retrying every ${retrySeconds} s.`)}`,
    '</pre>',
  ].join('\n');
}

export function formatRecovered(sample: NodeSample): string {
  const lines = [
    `Blocks       ${blocksLine(sample)}`,
    `Verified     ${Number.isFinite(sample.verificationProgress) ? formatVerification(sample.verificationProgress) : 'unknown'}`,
    `Peers        ${peersLine(sample)}`,
    `Sampled      ${utcTimestamp(sample.sampledAt)}`,
  ];
  return `✅ Node reachable again — monitoring resumed\n\n<pre>\n${lines.join('\n')}\n</pre>`;
}

export function formatMonitorStatus(
  subscription: SubscriptionStatusView,
  sample: NodeSample,
): string {
  const step = subscription.progressStepPercent;
  const bucket = progressBucket(sample.progressPercent, step);
  const next = nextProgressPercent(sample.progressPercent, step);
  const lastSent = subscription.lastSentAt
    ? utcTimestamp(new Date(subscription.lastSentAt))
    : 'never';
  const lastProgress =
    subscription.lastSentProgress === null
      ? ''
      : `  (${formatProgress(subscription.lastSentProgress)})`;
  const lines = [
    `Monitoring   ${subscription.active ? 'yes' : 'no'}`,
    `Step         every ${step}%`,
    `Last state   ${subscription.lastState}`,
    `Last sent    ${lastSent}${lastProgress}`,
    `Progress     ${formatProgress(sample.progressPercent)}  (bucket ${bucket})`,
    `Next update  ${next === null ? '—  (waiting for completion)' : `at ${next.toFixed(1)}%`}`,
  ];
  return `📊 IBD monitor subscription\n\n<pre>\n${lines.join('\n')}\n</pre>`;
}

/**
 * Generic transition helper used by tests/callers that only have `prev`/`next`
 * samples. Returns null when there is no notable event.
 */
export function formatEvent(
  previous: NodeSample | null,
  next: NodeSample,
  reorgTolerance = 12,
): string | null {
  if (isNodeSynced(next) && (!previous || !isNodeSynced(previous))) {
    return formatIbdFinished(next);
  }
  if (previous && previous.blocks - next.blocks > reorgTolerance) {
    return formatRegression(previous, next);
  }
  return null;
}
