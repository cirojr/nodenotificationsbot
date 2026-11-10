export function helpMessage(): string {
  return [
    '👋 <b>NodeNotificationsBot</b>',
    '',
    'I report the initial block download (IBD) progress of a Bitcoin Core node.',
    '',
    '<b>Commands</b>',
    '/ibd — current node snapshot',
    '/ibd watch [step] — subscribe to progress updates (default every 10%, range 1–50)',
    '/ibd status — your subscription and the current snapshot',
    '/ibd stop — stop progress updates',
    '',
    '<i>Subscription updates are percentage-triggered: one message per crossed step, plus a final message when IBD finishes.</i>',
  ].join('\n');
}

export function notAllowedMessage(): string {
  return '⛔️ This chat is not allowed to use the IBD monitor.';
}

export function disabledMessage(): string {
  return '😴 The IBD monitor is currently disabled by the operator.';
}

export function invalidStepMessage(min: number, max: number): string {
  return `Step must be a whole number between <b>${min}</b> and <b>${max}</b> percent, for example <code>/ibd watch 10</code>.`;
}

export function capReachedMessage(maxSubscriptions: number): string {
  return `The server-wide limit of <b>${maxSubscriptions}</b> active IBD subscriptions has been reached. Try again after someone runs /ibd stop.`;
}

export function stoppedMessage(): string {
  return '🛑 IBD monitoring stopped. Use /ibd watch to start again.';
}

export function noSubscriptionMessage(): string {
  return 'You are not subscribed to IBD updates. Use /ibd watch to start.';
}

export function throttledMessage(seconds: number): string {
  return `⏳ Please wait ${seconds} s between /ibd commands.`;
}

export function usageMessage(): string {
  return [
    '<b>IBD commands</b>',
    '/ibd — current node snapshot',
    '/ibd watch [step] — subscribe (default 10%)',
    '/ibd status — subscription and snapshot',
    '/ibd stop — stop updates',
  ].join('\n');
}

export function unreachableMessage(error: string): string {
  const safe = error
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return `🔌 Node unreachable.\n\n<pre>${safe}</pre>\nI will keep retrying; try again in a moment.`;
}

export function botErrorMessage(): string {
  return '⚠️ Something went wrong while handling that command. The error was logged.';
}
