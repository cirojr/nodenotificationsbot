import {autoRetry} from '@grammyjs/auto-retry';
import {Bot, type Context} from 'grammy';
import type {AppConfig} from '../config';
import type {Logger} from '../logger';
import {sanitizeRpcError} from '../bitcoin/rpcClient';
import {isNodeSynced} from '../bitcoin/nodeStatus';
import type {
  IbdMonitor,
  MessageSender,
  SendResult,
} from '../services/ibdMonitor';
import {formatIbdFinished, formatSnapshot} from './ibdMessages';
import {
  botErrorMessage,
  helpMessage,
  monitoringEnabledMessage,
  noSubscriptionMessage,
  stoppedMessage,
  unknownCommandMessage,
} from './messages';

interface TelegramErrorDetails {
  code: number | undefined;
  description: string;
}

function telegramErrorDetails(error: unknown): TelegramErrorDetails {
  if (typeof error === 'object' && error !== null) {
    const candidate = error as {
      error_code?: unknown;
      description?: unknown;
      message?: unknown;
      response?: {error_code?: unknown; description?: unknown};
    };
    const code =
      typeof candidate.error_code === 'number'
        ? candidate.error_code
        : typeof candidate.response?.error_code === 'number'
          ? candidate.response.error_code
          : undefined;
    const description =
      typeof candidate.response?.description === 'string'
        ? candidate.response.description
        : typeof candidate.description === 'string'
          ? candidate.description
          : typeof candidate.message === 'string'
            ? candidate.message
            : 'Telegram request failed';
    return {code, description};
  }
  return {code: undefined, description: String(error)};
}

export function createBot(config: AppConfig): Bot {
  const bot = new Bot(config.telegram.botToken);
  bot.api.config.use(
    autoRetry({
      maxRetryAttempts: 3,
      maxDelaySeconds: 30,
      // Network errors are retried without an attempt limit by default.
      rethrowHttpErrors: true,
    }),
  );
  return bot;
}

/** Bot API sender used by the monitor; failures are mapped for retry/deactivation. */
export function createTelegramSender(bot: Bot): MessageSender {
  return {
    async send(chatId: number, html: string): Promise<SendResult> {
      try {
        await bot.api.sendMessage(chatId, html, {
          parse_mode: 'HTML',
          link_preview_options: {is_disabled: true},
        });
        return {ok: true};
      } catch (error) {
        const {code, description} = telegramErrorDetails(error);
        const blocked =
          code === 403 ||
          (code === 400 &&
            /chat not found|deactivated|bot was blocked|user is deactivated/i.test(
              description,
            ));
        const retryable = code === undefined || code === 429 || code >= 500;
        return {ok: false, error: description, retryable, blocked};
      }
    },
  };
}

export function registerHandlers(
  bot: Bot,
  monitor: IbdMonitor,
  config: AppConfig,
  logger: Logger,
): void {
  const step = config.ibdMonitor.progressStepPercent;

  async function replyHelp(ctx: Context): Promise<void> {
    await ctx.reply(helpMessage(step), {
      parse_mode: 'HTML',
      link_preview_options: {is_disabled: true},
    });
  }

  async function handleIbd(ctx: Context): Promise<void> {
    const chatId = ctx.chat?.id;
    if (chatId === undefined) {
      return;
    }

    const match = typeof ctx.match === 'string' ? ctx.match.trim() : '';
    const subcommand =
      match.length > 0 ? match.split(/\s+/)[0]?.toLowerCase() : undefined;

    if (subcommand === 'stop') {
      try {
        const stopped = await monitor.unsubscribe(chatId);
        await ctx.reply(stopped ? stoppedMessage() : noSubscriptionMessage(), {
          parse_mode: 'HTML',
        });
      } catch (error) {
        logger.error(
          {error: sanitizeRpcError(error)},
          'failed to stop IBD monitoring',
        );
        await ctx.reply(botErrorMessage(), {parse_mode: 'HTML'});
      }
      return;
    }

    if (subcommand !== undefined) {
      await replyHelp(ctx);
      return;
    }

    try {
      const sample = await monitor.subscribe(chatId);
      const message = isNodeSynced(sample)
        ? formatIbdFinished(sample)
        : `${formatSnapshot(sample, {stepPercent: step})}\n\n${monitoringEnabledMessage(step)}`;
      await ctx.reply(message, {
        parse_mode: 'HTML',
        link_preview_options: {is_disabled: true},
      });
    } catch (error) {
      await ctx.reply(monitor.describeUnreachable(error), {
        parse_mode: 'HTML',
        link_preview_options: {is_disabled: true},
      });
    }
  }

  bot.command('start', replyHelp);
  bot.command('help', replyHelp);
  bot.command('ibd', handleIbd);

  bot.on('message:text', async ctx => {
    if (ctx.chat.type !== 'private') {
      return;
    }
    const text = ctx.message.text.trim();
    if (text.startsWith('/')) {
      await ctx.reply(unknownCommandMessage(step), {parse_mode: 'HTML'});
      return;
    }
    await replyHelp(ctx);
  });

  bot.catch(error => {
    const details = telegramErrorDetails(error.error);
    logger.error(
      {
        error: details.description,
        code: details.code,
        updateId: error.ctx.update.update_id,
      },
      'telegram bot error',
    );
  });
}
