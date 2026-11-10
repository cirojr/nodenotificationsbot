import {autoRetry} from '@grammyjs/auto-retry';
import {Bot, type Context} from 'grammy';
import type {AppConfig} from '../config';
import type {Logger} from '../logger';
import {sanitizeRpcError} from '../bitcoin/rpcClient';
import type {IbdMonitor} from '../services/ibdMonitor';
import {
  IbdMonitorError,
  type MessageSender,
  type SendResult,
} from '../services/ibdMonitor';
import {
  botErrorMessage,
  capReachedMessage,
  disabledMessage,
  helpMessage,
  invalidStepMessage,
  noSubscriptionMessage,
  notAllowedMessage,
  stoppedMessage,
  throttledMessage,
  unreachableMessage,
  usageMessage,
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

function isStepInteger(value: string): boolean {
  return /^\d+$/.test(value);
}

export function registerHandlers(
  bot: Bot,
  monitor: IbdMonitor,
  config: AppConfig,
  logger: Logger,
): void {
  const lastCommandAt = new Map<number, number>();

  function throttled(chatId: number): boolean {
    const throttleSeconds = config.ibdMonitor.commandThrottleSeconds;
    if (throttleSeconds <= 0) {
      return false;
    }
    const now = Date.now();
    const last = lastCommandAt.get(chatId);
    if (last !== undefined && now - last < throttleSeconds * 1_000) {
      return true;
    }
    lastCommandAt.set(chatId, now);
    return false;
  }

  async function replyHelp(ctx: Context): Promise<void> {
    await ctx.reply(helpMessage(), {
      parse_mode: 'HTML',
      link_preview_options: {is_disabled: true},
    });
  }

  async function handleIbd(ctx: Context): Promise<void> {
    const chatId = ctx.chat?.id;
    if (chatId === undefined) {
      return;
    }

    if (!monitor.isChatAllowed(chatId)) {
      await ctx.reply(notAllowedMessage(), {parse_mode: 'HTML'});
      return;
    }

    const match = typeof ctx.match === 'string' ? ctx.match.trim() : '';
    const args = match.length > 0 ? match.split(/\s+/) : [];
    const subcommand = args[0]?.toLowerCase();

    if (subcommand === 'stop') {
      try {
        const stopped = await monitor.unsubscribe(chatId);
        await ctx.reply(stopped ? stoppedMessage() : noSubscriptionMessage(), {
          parse_mode: 'HTML',
        });
      } catch (error) {
        await replyMonitorError(ctx, error, config);
      }
      return;
    }

    if (!config.ibdMonitor.enabled) {
      await ctx.reply(disabledMessage(), {parse_mode: 'HTML'});
      return;
    }

    if (throttled(chatId)) {
      await ctx.reply(
        throttledMessage(config.ibdMonitor.commandThrottleSeconds),
        {parse_mode: 'HTML'},
      );
      return;
    }

    if (subcommand === undefined) {
      try {
        const sample = await monitor.snapshot();
        await ctx.reply(
          monitor.describe(
            sample,
            config.ibdMonitor.defaultProgressStepPercent,
          ),
          {
            parse_mode: 'HTML',
            link_preview_options: {is_disabled: true},
          },
        );
      } catch (error) {
        await ctx.reply(unreachableMessage(sanitizeRpcError(error)), {
          parse_mode: 'HTML',
          link_preview_options: {is_disabled: true},
        });
      }
      return;
    }

    if (subcommand === 'watch') {
      const rawStep = args[1];
      let step: number | undefined;
      if (rawStep !== undefined) {
        if (!isStepInteger(rawStep)) {
          await ctx.reply(
            invalidStepMessage(
              config.ibdMonitor.minProgressStepPercent,
              config.ibdMonitor.maxProgressStepPercent,
            ),
            {parse_mode: 'HTML'},
          );
          return;
        }
        step = Number(rawStep);
        if (
          step < config.ibdMonitor.minProgressStepPercent ||
          step > config.ibdMonitor.maxProgressStepPercent
        ) {
          await ctx.reply(
            invalidStepMessage(
              config.ibdMonitor.minProgressStepPercent,
              config.ibdMonitor.maxProgressStepPercent,
            ),
            {parse_mode: 'HTML'},
          );
          return;
        }
      }

      try {
        await monitor.subscribe(chatId, step);
      } catch (error) {
        await replyMonitorError(ctx, error, config);
      }
      return;
    }

    if (subcommand === 'status') {
      try {
        const status = await monitor.status(chatId);
        const header = monitor.formatStatusMessage(status);
        const snapshot =
          status.sample === null
            ? ''
            : `\n\n${monitor.describe(
                status.sample,
                status.subscription?.progressStepPercent ??
                  config.ibdMonitor.defaultProgressStepPercent,
              )}`;
        await ctx.reply(`${header}${snapshot}`, {
          parse_mode: 'HTML',
          link_preview_options: {is_disabled: true},
        });
      } catch (error) {
        await replyMonitorError(ctx, error, config);
      }
      return;
    }

    await ctx.reply(usageMessage(), {parse_mode: 'HTML'});
  }

  async function replyMonitorError(
    ctx: Context,
    error: unknown,
    appConfig: AppConfig,
  ): Promise<void> {
    if (error instanceof IbdMonitorError) {
      switch (error.code) {
        case 'not_allowed':
          await ctx.reply(notAllowedMessage(), {parse_mode: 'HTML'});
          return;
        case 'disabled':
          await ctx.reply(disabledMessage(), {parse_mode: 'HTML'});
          return;
        case 'invalid_step':
          await ctx.reply(
            invalidStepMessage(
              appConfig.ibdMonitor.minProgressStepPercent,
              appConfig.ibdMonitor.maxProgressStepPercent,
            ),
            {parse_mode: 'HTML'},
          );
          return;
        case 'cap_reached':
          await ctx.reply(
            capReachedMessage(appConfig.ibdMonitor.maxSubscriptions),
            {parse_mode: 'HTML'},
          );
          return;
        case 'unreachable':
          await ctx.reply(unreachableMessage(sanitizeRpcError(error)), {
            parse_mode: 'HTML',
          });
          return;
      }
    }
    logger.error(
      {error: sanitizeRpcError(error)},
      'unhandled error in /ibd command',
    );
    await ctx.reply(botErrorMessage(), {parse_mode: 'HTML'});
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
      await ctx.reply(
        'Unknown command. Use /help to see the available commands.',
        {parse_mode: 'HTML'},
      );
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
