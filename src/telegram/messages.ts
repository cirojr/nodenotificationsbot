export function helpMessage(stepPercent: number): string {
  return [
    '👋 <b>NodeNotificationsBot</b>',
    '',
    'I report the initial block download (IBD) progress of a Bitcoin Core node.',
    '',
    '<b>Commands</b>',
    '/ibd — live node snapshot and start monitoring',
    '/ibd stop — stop monitoring',
    '',
    `<i>While monitoring, you get an update every ${stepPercent}% and a final message when IBD finishes. The subscription is removed automatically after completion.</i>`,
  ].join('\n');
}

export function monitoringEnabledMessage(stepPercent: number): string {
  return `📡 Monitoring is on — you will get an update every ${stepPercent}% and a final message when IBD finishes. Send /ibd stop to unsubscribe.`;
}

export function stoppedMessage(): string {
  return '🛑 IBD monitoring stopped. Send /ibd to start again.';
}

export function noSubscriptionMessage(): string {
  return 'You are not monitoring IBD progress. Send /ibd to start.';
}

export function unknownCommandMessage(stepPercent: number): string {
  return `Unknown command. Use /help to see the available commands.\n\n${helpMessage(stepPercent)}`;
}

export function botErrorMessage(): string {
  return '⚠️ Something went wrong while handling that command. The error was logged.';
}
