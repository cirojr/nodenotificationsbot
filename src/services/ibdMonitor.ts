import type {IbdMonitorConfig} from '../config';
import type {Logger} from '../logger';
import {
  isNodeSynced,
  type NodeSample,
  type Sampler,
} from '../bitcoin/nodeStatus';
import {sanitizeRpcError, rpcEndpointLabel} from '../bitcoin/rpcClient';
import {
  formatIbdFinished,
  formatRecovered,
  formatSnapshot,
  formatUnreachable,
} from '../telegram/ibdMessages';
import {progressBucket, shouldSendProgress} from './progress';
import type {MonitoredChat, MonitoredChatRepo} from '../storage';

export type SendResult =
  {ok: true} | {ok: false; error: string; retryable: boolean; blocked: boolean};

export interface MessageSender {
  send(chatId: number, html: string): Promise<SendResult>;
}

export interface IbdMonitorDeps {
  repo: MonitoredChatRepo;
  sampler: Sampler;
  sender: MessageSender;
  config: IbdMonitorConfig;
  logger: Logger;
  /** Human label for the RPC endpoint used in "unreachable" messages. */
  rpcUrl: string;
}

/** Best-effort cap so a slow Telegram call cannot block shutdown forever. */
const STOP_WAIT_MS = 5_000;

/**
 * Shared IBD sampler plus a small per-chat state machine.
 *
 * A single interval samples the node while at least one chat is subscribed.
 * The persistent state is only `last_state` and the last progress bucket;
 * the bot does not cache samples, track speed/ETA, or persist alert history.
 */
export class IbdMonitor {
  private readonly repo: MonitoredChatRepo;
  private readonly sampler: Sampler;
  private readonly sender: MessageSender;
  private readonly config: IbdMonitorConfig;
  private readonly logger: Logger;
  private readonly rpcLabel: string;

  private timer: NodeJS.Timeout | null = null;
  private activeTick: Promise<void> | null = null;
  private pendingTick = false;
  private stopping = false;

  constructor(deps: IbdMonitorDeps) {
    this.repo = deps.repo;
    this.sampler = deps.sampler;
    this.sender = deps.sender;
    this.config = deps.config;
    this.logger = deps.logger;
    this.rpcLabel = rpcEndpointLabel(deps.rpcUrl);
  }

  start(): void {
    if (this.timer) {
      return;
    }
    this.stopping = false;
    const intervalMs = this.config.sampleIntervalSeconds * 1_000;
    this.timer = setInterval(() => {
      void this.tick();
    }, intervalMs);
    this.logger.info(
      {
        sampleIntervalSeconds: this.config.sampleIntervalSeconds,
        progressStepPercent: this.config.progressStepPercent,
      },
      'ibd monitor started',
    );
    void this.tick();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.activeTick) {
      await Promise.race([
        this.activeTick,
        new Promise<void>(resolve => {
          const timer = setTimeout(resolve, STOP_WAIT_MS);
          timer.unref();
        }),
      ]);
    }
    this.logger.info('ibd monitor stopped');
  }

  /**
   * One sampling/evaluation cycle. Public so tests can drive the monitor with
   * a fake sampler; overlap is serialized with a "run again" flag.
   */
  async tick(): Promise<void> {
    if (this.stopping) {
      return;
    }
    if (this.activeTick) {
      this.pendingTick = true;
      await this.activeTick;
      return;
    }

    this.activeTick = this.runTick()
      .catch((error: unknown) => {
        this.logger.error(
          {error: sanitizeRpcError(error)},
          'ibd monitor tick failed unexpectedly',
        );
      })
      .finally(() => {
        this.activeTick = null;
        if (this.pendingTick && !this.stopping) {
          this.pendingTick = false;
          void this.tick();
        }
      });

    await this.activeTick;
  }

  private async runTick(): Promise<void> {
    const chats = this.repo.list();
    if (chats.length === 0) {
      return;
    }

    let sample: NodeSample;
    try {
      sample = await this.sampler.sample();
    } catch (error) {
      await this.handleUnreachable(chats, error);
      return;
    }

    this.logger.debug(
      {
        blocks: sample.blocks,
        headers: sample.headers,
        progress: Number(sample.progressPercent.toFixed(3)),
        peers: sample.peers?.total ?? null,
        ibd: sample.initialBlockDownload,
      },
      'IBD sample',
    );

    if (isNodeSynced(sample)) {
      await this.handleSynced(chats, sample);
      return;
    }

    const step = this.config.progressStepPercent;
    for (const chat of chats) {
      try {
        await this.evaluateChat(chat, sample, step);
      } catch (error) {
        this.logger.error(
          {chatId: chat.chatId, error: sanitizeRpcError(error)},
          'failed to evaluate monitored chat',
        );
      }
    }
  }

  private async evaluateChat(
    chat: MonitoredChat,
    sample: NodeSample,
    step: number,
  ): Promise<void> {
    const bucket = progressBucket(sample.progressPercent, step);

    if (chat.lastState === 'unreachable') {
      const result = await this.sendMessage(
        chat.chatId,
        formatRecovered(sample),
      );
      if (result.ok) {
        this.repo.update(chat.chatId, {
          lastState: 'ibd',
          lastSentBucket: bucket,
        });
        this.logger.info({chatId: chat.chatId}, 'IBD monitor recovered');
      } else {
        await this.onSendFailure(chat.chatId, result);
      }
      return;
    }

    // Progress moved backwards (e.g. reindex). Reset the baseline silently;
    // the next forward bucket triggers a normal snapshot.
    if (chat.lastSentBucket !== null && bucket < chat.lastSentBucket) {
      this.repo.update(chat.chatId, {lastSentBucket: bucket});
      this.logger.info(
        {chatId: chat.chatId, bucket},
        'IBD progress moved backwards; reset baseline',
      );
      return;
    }

    if (shouldSendProgress(chat.lastSentBucket, sample.progressPercent, step)) {
      const result = await this.sendMessage(
        chat.chatId,
        formatSnapshot(sample, {stepPercent: step}),
      );
      if (result.ok) {
        this.repo.update(chat.chatId, {
          lastState: 'ibd',
          lastSentBucket: bucket,
        });
        this.logger.info(
          {
            chatId: chat.chatId,
            blocks: sample.blocks,
            headers: sample.headers,
            progress: Number(sample.progressPercent.toFixed(3)),
            step,
          },
          'sent IBD progress update',
        );
      } else {
        await this.onSendFailure(chat.chatId, result);
      }
      return;
    }

    if (chat.lastState !== 'ibd') {
      this.repo.update(chat.chatId, {lastState: 'ibd'});
    }
  }

  private async handleSynced(
    chats: MonitoredChat[],
    sample: NodeSample,
  ): Promise<void> {
    for (const chat of chats) {
      const result = await this.sendMessage(
        chat.chatId,
        formatIbdFinished(sample),
      );
      if (result.ok || result.blocked) {
        this.repo.remove(chat.chatId);
        this.logger.info(
          {chatId: chat.chatId, blocked: !result.ok},
          'IBD finished; cleared monitored chat',
        );
        continue;
      }
      if (!result.retryable) {
        this.repo.remove(chat.chatId);
        this.logger.warn(
          {chatId: chat.chatId, error: result.error},
          'dropping chat after non-retryable completion failure',
        );
        continue;
      }
      this.repo.update(chat.chatId, {lastState: 'synced'});
      this.logger.warn(
        {chatId: chat.chatId, error: result.error},
        'completion message failed; will retry',
      );
    }

    if (this.repo.list().length === 0) {
      this.logger.info('IBD finished; all monitored chats cleared');
    }
  }

  private async handleUnreachable(
    chats: MonitoredChat[],
    error: unknown,
  ): Promise<void> {
    const safeError = sanitizeRpcError(error);
    this.logger.warn(
      {error: safeError},
      'IBD sample failed; node appears unreachable',
    );

    for (const chat of chats) {
      if (chat.lastState === 'unreachable') {
        continue;
      }
      const result = await this.sendMessage(
        chat.chatId,
        formatUnreachable(
          this.rpcLabel,
          safeError,
          this.config.sampleIntervalSeconds,
        ),
      );
      if (result.ok) {
        this.repo.update(chat.chatId, {lastState: 'unreachable'});
        this.logger.info({chatId: chat.chatId}, 'IBD monitor unreachable');
      } else if (result.blocked) {
        this.repo.remove(chat.chatId);
        this.logger.info(
          {chatId: chat.chatId},
          'removed chat after Telegram blocked the bot',
        );
      }
    }
  }

  /**
   * Save the chat and take a live sample for the `/ibd` reply. If the node is
   * already synced, remove any existing row and return the sample so the
   * caller can reply with the completion message.
   */
  async subscribe(chatId: number): Promise<NodeSample> {
    let sample: NodeSample;
    try {
      sample = await this.sampler.sample();
    } catch (error) {
      this.repo.add(chatId);
      this.repo.update(chatId, {lastState: 'unreachable'});
      throw error;
    }

    if (isNodeSynced(sample)) {
      this.repo.remove(chatId);
      return sample;
    }

    this.repo.add(chatId);
    this.repo.update(chatId, {
      lastState: 'ibd',
      lastSentBucket: progressBucket(
        sample.progressPercent,
        this.config.progressStepPercent,
      ),
    });
    this.logger.info({chatId}, 'IBD monitoring subscribed');
    return sample;
  }

  async unsubscribe(chatId: number): Promise<boolean> {
    return this.repo.remove(chatId);
  }

  /** Format an RPC error for a `/ibd` command reply. */
  describeUnreachable(error: unknown): string {
    return formatUnreachable(
      this.rpcLabel,
      sanitizeRpcError(error),
      this.config.sampleIntervalSeconds,
    );
  }

  private async sendMessage(chatId: number, html: string): Promise<SendResult> {
    return this.sender.send(chatId, html);
  }

  private async onSendFailure(
    chatId: number,
    result: Extract<SendResult, {ok: false}>,
  ): Promise<void> {
    this.logger.warn(
      {chatId, error: result.error, retryable: result.retryable},
      'failed to send IBD message',
    );
    if (result.blocked) {
      this.repo.remove(chatId);
      this.logger.info({chatId}, 'removed chat after Telegram blocked the bot');
    }
  }
}
