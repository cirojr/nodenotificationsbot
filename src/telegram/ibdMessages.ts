import {isNodeSynced, type NodeSample} from '../bitcoin/nodeStatus';
import {nextProgressPercent} from '../services/progress';

const integerFormatter = new Intl.NumberFormat('en-US', {
  maximumFractionDigits: 0,
});

export interface SnapshotContext {
  stepPercent?: number;
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

export function formatSnapshot(
  sample: NodeSample,
  context: SnapshotContext = {},
): string {
  const synced = isNodeSynced(sample);
  const header = synced
    ? '✅ Node is not in IBD — chain is synced'
    : `🟡 Node is in IBD — ${formatProgress(sample.progressPercent)}`;

  const lines: string[] = [];
  lines.push(`Chain        ${escapeHtml(sample.chain)}`);

  if (synced) {
    lines.push(
      `Blocks       ${formatInt(sample.blocks)} / ${formatInt(sample.headers)}  (0 behind)`,
    );
    lines.push(
      `Verified     ${formatVerification(sample.verificationProgress)}`,
    );
  } else if (sample.headers <= 0) {
    lines.push(
      `Blocks       ${formatInt(sample.blocks)} / 0  (waiting for headers)`,
    );
    lines.push('Status       waiting for headers from peers');
  } else {
    lines.push(`Blocks       ${blocksLine(sample)}`);
    lines.push(`Headers      ${formatInt(sample.headers)}`);
    lines.push(
      `Verified     ${formatVerification(sample.verificationProgress)}`,
    );
    const behind = Math.max(0, sample.headers - sample.blocks);
    lines.push(`Remaining    ${formatInt(behind)} blocks`);
    lines.push(...progressFooter(sample, context));
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
    `${escapeHtml(`RPC at ${rpcLabel} did not answer: ${sanitized}. I will keep checking every ${retrySeconds} s and message you once when the node is reachable again.`)}`,
    '</pre>',
  ].join('\n');
}

export function formatRecovered(sample: NodeSample): string {
  const lines = [
    `Blocks       ${blocksLine(sample)}`,
    `Verified     ${formatVerification(sample.verificationProgress)}`,
    `Peers        ${peersLine(sample)}`,
    `Sampled      ${utcTimestamp(sample.sampledAt)}`,
  ];
  return `✅ Node reachable again — monitoring resumed\n\n<pre>\n${lines.join('\n')}\n</pre>`;
}
