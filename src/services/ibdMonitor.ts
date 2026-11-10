import type {IbdMonitorConfig} from '../config';
import type {Logger} from '../logger';
import {
  isNodeSynced,
  type NodeSample,
  type Sampler,
} from '../bitcoin/nodeStatus';
import {sanitizeRpcError, rpcEndpointLabel} from '../bitcoin/rpcClient';
import {
  escapeHtml,
  formatIbdFinished,
  formatMonitorStatus,
  formatRecovered,
  formatRegression,
  formatSnapshot,
  formatStall,
  formatUnreachable,
} from '../telegram/ibdMessages';
import {estimateEtaMinutes, progressBucket, SpeedTracker} from './progress';
import type {NodeMonitorSubscriptionRepo, Subscription} from '../storage';

export type SendResult =
  {ok: true} | {ok: false; error: string; retryable: boolean; blocked: boolean};

export interface MessageSender {
  send(chatId: number, html: string): Promise<SendResult>;
}

export type IbdMonitorErrorCode =
  'not_allowed' | 'invalid_step' | 'cap_reached' | 'disabled' | 'unreachable';

export class IbdMonitorError extends Error {
  readonly code: IbdMonitorErrorCode;

  constructor(code: IbdMonitorErrorCode, message: string) {
    super(message);
    this.name = 'IbdMonitorError';
    this.code = code;
  }
}

export interface IbdMonitorDeps {
  repo: NodeMonitorSubscriptionRepo;
  sampler: Sampler;
  sender: MessageSender;
  config: IbdMonitorConfig;
  logger: Logger;
  adminChatIds?: number[];
  /** Human label for the RPC endpoint used in "unreachable" messages. */
  rpcUrl: string;
  /** Injectable clock (ms) for tests. */
  now?: () => number;
  /** Cache TTL for on-demand /ibd snapshots. */
  sampleCacheTtlMs?: number;
}

interface RuntimeState {
  lastBlocks: number | null;
  blocksUnchangedSince: number;
  lastHeaders: number | null;
  headersUnchangedSince: number;
  peersZeroSince: number | null;
  unreachableSince: number | null;
}

interface CachedSample {
  sample: NodeSample;
  at: number;
}

const DEFAULT_CACHE_TTL_MS = 30_000;
/** Best-effort cap so a slow Telegram call cannot block shutdown forever. */
const STOP_WAIT_MS = 5_000;

export interface MonitorStatus {
  subscription: Subscription | null;
  sample: NodeSample | null;
  error: string | null;
}

/**
 * Shared IBD sampler plus per-subscription progress/state machine.
 *
 * A single interval samples the node; subscriptions are evaluated from that
 * shared sample. The monitor never throws out of the timer: RPC failures are
 * logged and surfaced as the `unreachable` state, as required by the plan.
 */
export class IbdMonitor {
  private readonly repo: NodeMonitorSubscriptionRepo;
  private readonly sampler: Sampler;
  private readonly sender: MessageSender;
  private readonly config: IbdMonitorConfig;
  private readonly logger: Logger;
  private readonly adminChatIds: number[];
  private readonly rpcLabel: string;
  private readonly now: () => number;
  private readonly cacheTtlMs: number;
  private readonly speedTracker: SpeedTracker;
  private readonly runtime = new Map<number, RuntimeState>();
  private readonly startedAt: number;

  private timer: NodeJS.Timeout | null = null;
  private activeTick: Promise<void> | null = null;
  private pendingTick = false;
  private stopping = false;

  private cached: CachedSample | null = null;
  private previousSample: NodeSample | null = null;
  private sampleInFlight: Promise<NodeSample> | null = null;

  private lastSuccessAt: number | null = null;
  private adminUnreachableAlerted = false;

  constructor(deps: IbdMonitorDeps) {
    this.repo = deps.repo;
    this.sampler = deps.sampler;
    this.sender = deps.sender;
    this.config = deps.config;
    this.logger = deps.logger;
    this.adminChatIds = deps.adminChatIds ?? [];
    this.rpcLabel = rpcEndpointLabel(deps.rpcUrl);
    this.now = deps.now ?? Date.now;
    this.cacheTtlMs = deps.sampleCacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.startedAt = this.now();
    this.speedTracker = new SpeedTracker({
      windowMinutes: deps.config.speedWindowMinutes,
      now: this.now,
    });
  }

  start(): void {
    if (!this.config.enabled || this.timer) {
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
        maxSubscriptions: this.config.maxSubscriptions,
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
   * a fake clock; overlap is serialized with a "run again" flag.
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
    let sample: NodeSample;
    try {
      sample = await this.takeSample();
    } catch (error) {
      await this.handleUnreachable(error);
      return;
    }

    const now = this.now();
    this.recordSuccessfulSample(sample, now);
    const previous = this.previousSample;
    this.previousSample = sample;

    const subscriptions = this.repo.listActive();
    for (const subscription of subscriptions) {
      if (!this.isChatAllowed(subscription.telegramChatId)) {
        this.logger.warn(
          {chatId: subscription.telegramChatId},
          'active subscription is outside allowedChatIds; deactivating',
        );
        this.repo.setActive(subscription.telegramChatId, false);
        continue;
      }
      const runtime = this.runtimeFor(subscription.telegramChatId, now);
      this.updateRuntime(runtime, sample, now);
      try {
        await this.evaluateSubscription(
          subscription,
          sample,
          previous,
          runtime,
          now,
        );
      } catch (error) {
        this.logger.error(
          {chatId: subscription.telegramChatId, error: sanitizeRpcError(error)},
          'failed to evaluate IBD subscription',
        );
      }
    }
  }

  private runtimeFor(chatId: number, now: number): RuntimeState {
    let runtime = this.runtime.get(chatId);
    if (!runtime) {
      runtime = {
        lastBlocks: null,
        blocksUnchangedSince: now,
        lastHeaders: null,
        headersUnchangedSince: now,
        peersZeroSince: null,
        unreachableSince: null,
      };
      this.runtime.set(chatId, runtime);
    }
    return runtime;
  }

  private updateRuntime(
    runtime: RuntimeState,
    sample: NodeSample,
    now: number,
  ): void {
    let blocksChanged = false;
    if (runtime.lastBlocks === null) {
      runtime.lastBlocks = sample.blocks;
      runtime.blocksUnchangedSince = now;
    } else if (sample.blocks !== runtime.lastBlocks) {
      runtime.lastBlocks = sample.blocks;
      runtime.blocksUnchangedSince = now;
      blocksChanged = true;
    }

    if (runtime.lastHeaders === null) {
      runtime.lastHeaders = sample.headers;
      runtime.headersUnchangedSince = now;
    } else if (sample.headers !== runtime.lastHeaders) {
      runtime.lastHeaders = sample.headers;
      runtime.headersUnchangedSince = now;
    }

    if (sample.peers !== null && sample.peers.total === 0) {
      // A zero-peer stall needs 15 quiet minutes too; if blocks advance, restart
      // the window so real progress is never reported as a stall.
      if (blocksChanged) {
        runtime.peersZeroSince = now;
      } else {
        runtime.peersZeroSince ??= now;
      }
    } else {
      runtime.peersZeroSince = null;
    }
    runtime.unreachableSince = null;
  }

  private async evaluateSubscription(
    subscription: Subscription,
    sample: NodeSample,
    previous: NodeSample | null,
    runtime: RuntimeState,
    now: number,
  ): Promise<void> {
    const chatId = subscription.telegramChatId;
    const step = subscription.progressStepPercent;
    const synced = isNodeSynced(sample);

    // 1. Recovery from an unreachable episode: short message, reset baseline.
    if (subscription.lastState === 'unreachable') {
      const result = await this.sendMessage(chatId, formatRecovered(sample));
      if (!result.ok) {
        await this.onSendFailure(chatId, result);
        return;
      }
      this.repo.update(chatId, {
        lastState: synced ? 'synced' : 'ibd',
        lastProgressBucket: progressBucket(sample.progressPercent, step),
        lastSentProgress: sample.progressPercent,
        lastSentAt: this.iso(now),
        lastAlertAt: this.iso(now),
        active: true,
      });
      this.logger.info(
        {chatId, from: 'unreachable', to: synced ? 'synced' : 'ibd'},
        'IBD subscription recovered',
      );
      return;
    }

    // 2. Regression / reindex episode, detected from the previous good sample.
    const regressed =
      subscription.lastState === 'regressed'
        ? Boolean(previous && sample.blocks <= previous.blocks)
        : Boolean(
            previous &&
            previous.blocks - sample.blocks > this.config.reorgTolerance,
          );

    if (regressed) {
      if (!previous) {
        return;
      }
      if (
        subscription.lastState !== 'regressed' &&
        this.canSendStateAlert(subscription, now)
      ) {
        const result = await this.sendMessage(
          chatId,
          formatRegression(previous, sample),
        );
        if (result.ok) {
          this.repo.update(chatId, {
            lastState: 'regressed',
            lastProgressBucket: progressBucket(sample.progressPercent, step),
            lastSentProgress: sample.progressPercent,
            lastAlertAt: this.iso(now),
          });
          this.logger.info(
            {
              chatId,
              from: subscription.lastState,
              to: 'regressed',
              blocks: sample.blocks,
            },
            'IBD subscription regressed',
          );
        } else {
          await this.onSendFailure(chatId, result);
        }
      }
      return;
    }

    // 3. Synced: completion is sent once per transition, bypassing debounce.
    if (synced) {
      if (subscription.lastState !== 'synced') {
        const result = await this.sendMessage(
          chatId,
          formatIbdFinished(sample),
        );
        if (result.ok) {
          this.repo.update(chatId, {
            lastState: 'synced',
            lastProgressBucket: progressBucket(sample.progressPercent, step),
            lastSentProgress: sample.progressPercent,
            lastSentAt: this.iso(now),
            lastAlertAt: this.iso(now),
          });
          this.logger.info(
            {
              chatId,
              from: subscription.lastState,
              to: 'synced',
              blocks: sample.blocks,
            },
            'IBD subscription completed',
          );
        } else {
          await this.onSendFailure(chatId, result);
        }
      } else {
        this.maybeAutoStop(subscription, now);
      }
      return;
    }

    // 4. Stalled: still in IBD, no new blocks/headers or zero peers for the window.
    if (this.isStalled(runtime, now)) {
      if (
        subscription.lastState !== 'stalled' &&
        this.canSendStateAlert(subscription, now)
      ) {
        const stalledForMinutes = Math.max(
          this.config.stallMinutes,
          (now - runtime.blocksUnchangedSince) / 60_000,
          runtime.peersZeroSince === null
            ? 0
            : (now - runtime.peersZeroSince) / 60_000,
        );
        const result = await this.sendMessage(
          chatId,
          formatStall(sample, stalledForMinutes),
        );
        if (result.ok) {
          this.repo.update(chatId, {
            lastState: 'stalled',
            lastAlertAt: this.iso(now),
          });
          this.logger.info(
            {
              chatId,
              from: subscription.lastState,
              to: 'stalled',
              blocks: sample.blocks,
              stalledForMinutes,
            },
            'IBD subscription stalled',
          );
        } else {
          await this.onSendFailure(chatId, result);
        }
      }
      return;
    }

    // 5. Back to normal IBD after stalled/regressed: resume silently. An
    // `unknown` state (e.g. a failed creation message) falls through so the
    // first progress check can deliver a snapshot.
    if (
      subscription.lastState === 'stalled' ||
      subscription.lastState === 'regressed'
    ) {
      this.repo.update(chatId, {
        lastState: 'ibd',
        lastProgressBucket: progressBucket(sample.progressPercent, step),
        lastSentProgress: sample.progressPercent,
      });
      this.logger.info(
        {chatId, from: subscription.lastState, to: 'ibd'},
        'IBD subscription resumed',
      );
      return;
    }

    // 6. Percentage-bucket trigger. A multi-bucket jump sends one message.
    const bucket = progressBucket(sample.progressPercent, step);
    if (
      subscription.lastProgressBucket === null ||
      bucket > subscription.lastProgressBucket
    ) {
      const result = await this.sendMessage(
        chatId,
        formatSnapshot(sample, this.snapshotContext(subscription, sample, now)),
      );
      if (result.ok) {
        this.repo.update(chatId, {
          lastProgressBucket: bucket,
          lastSentProgress: sample.progressPercent,
          lastSentAt: this.iso(now),
        });
        this.logger.info(
          {
            chatId,
            blocks: sample.blocks,
            headers: sample.headers,
            progress: Number(sample.progressPercent.toFixed(3)),
            bucket,
            step,
          },
          'sent IBD progress update',
        );
      } else {
        await this.onSendFailure(chatId, result);
      }
      return;
    }

    // Progress moved backwards (e.g. restart/reindex): reset the baseline.
    if (bucket < subscription.lastProgressBucket) {
      this.repo.update(chatId, {lastProgressBucket: bucket});
    }

    // Optional time-based heartbeat; default 0 keeps this purely progress-driven.
    if (this.config.heartbeatMinutes > 0) {
      const heartbeatMs = this.config.heartbeatMinutes * 60_000;
      const lastSentAt = subscription.lastSentAt
        ? Date.parse(subscription.lastSentAt)
        : Number.NaN;
      if (!Number.isFinite(lastSentAt) || now - lastSentAt >= heartbeatMs) {
        const result = await this.sendMessage(
          chatId,
          formatSnapshot(
            sample,
            this.snapshotContext(subscription, sample, now),
          ),
        );
        if (result.ok) {
          this.repo.update(chatId, {
            lastSentAt: this.iso(now),
            lastSentProgress: sample.progressPercent,
          });
        } else {
          await this.onSendFailure(chatId, result);
        }
      }
    }
  }

  private isStalled(runtime: RuntimeState, now: number): boolean {
    const stallMs = this.config.stallMinutes * 60_000;
    const peersZero =
      runtime.peersZeroSince !== null &&
      now - runtime.peersZeroSince >= stallMs;
    const noNewBlocks = now - runtime.blocksUnchangedSince >= stallMs;
    const noNewHeaders = now - runtime.headersUnchangedSince >= stallMs;
    return peersZero || (noNewBlocks && noNewHeaders);
  }

  private canSendStateAlert(subscription: Subscription, now: number): boolean {
    if (!subscription.lastAlertAt) {
      return true;
    }
    const last = Date.parse(subscription.lastAlertAt);
    return (
      !Number.isFinite(last) ||
      now - last >= this.config.minAlertIntervalSeconds * 1_000
    );
  }

  private maybeAutoStop(subscription: Subscription, now: number): void {
    if (this.config.stopAfterSyncMinutes <= 0) {
      return;
    }
    const lastSentAt = subscription.lastSentAt
      ? Date.parse(subscription.lastSentAt)
      : Number.NaN;
    if (!Number.isFinite(lastSentAt)) {
      return;
    }
    if (now - lastSentAt < this.config.stopAfterSyncMinutes * 60_000) {
      return;
    }
    this.repo.setActive(subscription.telegramChatId, false);
    this.logger.info(
      {
        chatId: subscription.telegramChatId,
        stopAfterSyncMinutes: this.config.stopAfterSyncMinutes,
      },
      'auto-stopped IBD subscription after sync',
    );
  }

  private snapshotContext(
    subscription: Subscription,
    sample: NodeSample,
    now: number,
  ) {
    const speed = this.speedTracker.speedBlocksPerMinute(now);
    const span = this.speedTracker.spanMinutes(now);
    const behind = Math.max(0, sample.headers - sample.blocks);
    return {
      stepPercent: subscription.progressStepPercent,
      speedBlocksPerMinute: speed,
      speedWindowMinutes:
        span >= 1 ? Math.round(span) : this.config.speedWindowMinutes,
      etaMinutes: estimateEtaMinutes(behind, speed),
    };
  }

  private async handleUnreachable(error: unknown): Promise<void> {
    const now = this.now();
    const safeError = sanitizeRpcError(error);
    this.logger.warn(
      {error: safeError},
      'IBD sample failed; node appears unreachable',
    );

    const unreachableSince = this.lastSuccessAt ?? this.startedAt;
    const adminAlertMs = Math.min(
      3 * this.config.sampleIntervalSeconds * 1_000,
      this.config.unreachableAlertAfterMinutes * 60_000,
    );
    if (
      now - unreachableSince >= adminAlertMs &&
      !this.adminUnreachableAlerted
    ) {
      this.adminUnreachableAlerted = true;
      const minutes = Math.round((now - unreachableSince) / 60_000);
      await this.sendAdmins(
        `⚠️ <b>IBD monitor:</b> RPC has been unreachable for ${minutes} min.\n<pre>${escapeHtml(safeError)}</pre>`,
      );
    }

    for (const subscription of this.repo.listActive()) {
      const runtime = this.runtimeFor(subscription.telegramChatId, now);
      runtime.unreachableSince ??= now;

      if (subscription.lastState === 'unreachable') {
        continue;
      }
      if (
        now - runtime.unreachableSince <
        this.config.unreachableAlertAfterMinutes * 60_000
      ) {
        continue;
      }
      if (!this.canSendStateAlert(subscription, now)) {
        continue;
      }

      const result = await this.sendMessage(
        subscription.telegramChatId,
        formatUnreachable(
          this.rpcLabel,
          safeError,
          this.config.sampleIntervalSeconds,
        ),
      );
      if (result.ok) {
        this.repo.update(subscription.telegramChatId, {
          lastState: 'unreachable',
          lastAlertAt: this.iso(now),
        });
        this.logger.info(
          {
            chatId: subscription.telegramChatId,
            from: subscription.lastState,
            to: 'unreachable',
          },
          'IBD subscription unreachable',
        );
      } else {
        await this.onSendFailure(subscription.telegramChatId, result);
      }
    }
  }

  private recordSuccessfulSample(sample: NodeSample, now: number): void {
    this.cached = {sample, at: now};
    this.speedTracker.add(sample.blocks, now);
    this.lastSuccessAt = now;
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

    if (this.adminUnreachableAlerted) {
      this.adminUnreachableAlerted = false;
      void this.sendAdmins('✅ <b>IBD monitor:</b> RPC is reachable again.');
    }
  }

  private async sendAdmins(html: string): Promise<void> {
    for (const chatId of this.adminChatIds) {
      try {
        const result = await this.sender.send(chatId, html);
        if (!result.ok) {
          this.logger.warn(
            {chatId, error: result.error},
            'failed to send admin alert',
          );
        }
      } catch (error) {
        this.logger.warn(
          {chatId, error: sanitizeRpcError(error)},
          'failed to send admin alert',
        );
      }
    }
  }

  private async sendMessage(chatId: number, html: string): Promise<SendResult> {
    if (!this.isChatAllowed(chatId)) {
      return {
        ok: false,
        error: 'chat is no longer allowed by allowedChatIds',
        retryable: false,
        blocked: true,
      };
    }
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
      this.repo.setActive(chatId, false);
      this.logger.info(
        {chatId},
        'deactivated IBD subscription after Telegram blocked the bot',
      );
    }
  }

  private iso(at: number): string {
    return new Date(at).toISOString();
  }

  private async takeSample(): Promise<NodeSample> {
    if (!this.sampleInFlight) {
      const inFlight = this.sampler.sample().finally(() => {
        if (this.sampleInFlight === inFlight) {
          this.sampleInFlight = null;
        }
      });
      this.sampleInFlight = inFlight;
    }
    return this.sampleInFlight;
  }

  /** Cached snapshot for /ibd and /ibd status; reuses samples younger than 30 s. */
  async snapshot(options: {force?: boolean} = {}): Promise<NodeSample> {
    if (
      !options.force &&
      this.cached &&
      this.now() - this.cached.at < this.cacheTtlMs
    ) {
      return this.cached.sample;
    }
    const sample = await this.takeSample();
    this.recordSuccessfulSample(sample, this.now());
    return sample;
  }

  /** Format a snapshot with the shared speed/ETA context. */
  describe(sample: NodeSample, stepPercent: number): string {
    const now = this.now();
    const speed = this.speedTracker.speedBlocksPerMinute(now);
    const span = this.speedTracker.spanMinutes(now);
    return formatSnapshot(sample, {
      stepPercent,
      speedBlocksPerMinute: speed,
      speedWindowMinutes:
        span >= 1 ? Math.round(span) : this.config.speedWindowMinutes,
      etaMinutes: estimateEtaMinutes(
        Math.max(0, sample.headers - sample.blocks),
        speed,
      ),
    });
  }

  isChatAllowed(chatId: number): boolean {
    const allowed = this.config.allowedChatIds;
    if (allowed.length === 0) {
      return this.adminChatIds.includes(chatId);
    }
    if (allowed.some(entry => entry === '*')) {
      return true;
    }
    return allowed.some(entry => Number(entry) === chatId);
  }

  private assertChatAllowed(chatId: number): void {
    if (!this.isChatAllowed(chatId)) {
      throw new IbdMonitorError(
        'not_allowed',
        'this chat is not allowed to use the IBD monitor',
      );
    }
  }

  /**
   * Create or update a subscription and send the immediate snapshot.
   * Re-issuing `/ibd watch N` updates the step on the existing subscription.
   */
  async subscribe(
    chatId: number,
    requestedStepPercent?: number,
  ): Promise<Subscription> {
    if (!this.config.enabled) {
      throw new IbdMonitorError('disabled', 'the IBD monitor is disabled');
    }
    this.assertChatAllowed(chatId);

    const step = requestedStepPercent ?? this.config.defaultProgressStepPercent;
    if (
      !Number.isInteger(step) ||
      step < this.config.minProgressStepPercent ||
      step > this.config.maxProgressStepPercent
    ) {
      throw new IbdMonitorError(
        'invalid_step',
        `step must be an integer between ${this.config.minProgressStepPercent} and ${this.config.maxProgressStepPercent}`,
      );
    }

    const existing = this.repo.getByChatId(chatId);
    if (existing?.active) {
      this.repo.update(chatId, {progressStepPercent: step});
    } else if (existing) {
      if (this.repo.countActive() >= this.config.maxSubscriptions) {
        throw new IbdMonitorError(
          'cap_reached',
          `the server-wide limit of ${this.config.maxSubscriptions} active subscriptions has been reached`,
        );
      }
      this.repo.update(chatId, {active: true, progressStepPercent: step});
    } else {
      if (this.repo.countActive() >= this.config.maxSubscriptions) {
        throw new IbdMonitorError(
          'cap_reached',
          `the server-wide limit of ${this.config.maxSubscriptions} active subscriptions has been reached`,
        );
      }
      this.repo.create(chatId, step);
    }

    const now = this.now();

    let sample: NodeSample;
    try {
      sample = await this.snapshot();
    } catch (error) {
      const safeError = sanitizeRpcError(error);
      const runtime = this.runtimeFor(chatId, now);
      runtime.unreachableSince ??= now;
      const result = await this.sendMessage(
        chatId,
        formatUnreachable(
          this.rpcLabel,
          safeError,
          this.config.sampleIntervalSeconds,
        ),
      );
      this.repo.update(chatId, {
        lastState: 'unreachable',
        lastProgressBucket: null,
        lastSentProgress: null,
        ...(result.ok
          ? {lastAlertAt: this.iso(now), lastSentAt: this.iso(now)}
          : {}),
      });
      this.logger.warn(
        {chatId, error: safeError},
        'subscription created while node is unreachable',
      );
      return this.requireSubscription(chatId);
    }

    const synced = isNodeSynced(sample);
    const bucket = progressBucket(sample.progressPercent, step);
    const speed = this.speedTracker.speedBlocksPerMinute(now);
    const message = formatSnapshot(sample, {
      stepPercent: step,
      speedBlocksPerMinute: speed,
      speedWindowMinutes: this.config.speedWindowMinutes,
      etaMinutes: estimateEtaMinutes(
        Math.max(0, sample.headers - sample.blocks),
        speed,
      ),
    });
    const result = await this.sendMessage(chatId, message);

    this.repo.update(chatId, {
      progressStepPercent: step,
      active: true,
      lastState: result.ok
        ? synced
          ? 'synced'
          : 'ibd'
        : (existing?.lastState ?? 'unknown'),
      lastProgressBucket: result.ok ? bucket : null,
      lastSentProgress: result.ok ? sample.progressPercent : null,
      ...(result.ok ? {lastSentAt: this.iso(now)} : {}),
    });
    if (!result.ok) {
      await this.onSendFailure(chatId, result);
    }

    return this.requireSubscription(chatId);
  }

  private requireSubscription(chatId: number): Subscription {
    const subscription = this.repo.getByChatId(chatId);
    if (!subscription) {
      throw new IbdMonitorError(
        'disabled',
        `subscription for chat ${chatId} disappeared`,
      );
    }
    return subscription;
  }

  async unsubscribe(chatId: number): Promise<boolean> {
    this.assertChatAllowed(chatId);
    return this.repo.setActive(chatId, false);
  }

  /** Subscription settings plus a best-effort current sample for `/ibd status`. */
  async status(chatId: number): Promise<MonitorStatus> {
    this.assertChatAllowed(chatId);
    const subscription = this.repo.getByChatId(chatId);
    try {
      const sample = await this.snapshot();
      return {subscription, sample, error: null};
    } catch (error) {
      return {subscription, sample: null, error: sanitizeRpcError(error)};
    }
  }

  formatStatusMessage(status: MonitorStatus): string {
    if (!status.subscription) {
      return 'You are not subscribed to IBD updates. Use /ibd watch to start.';
    }
    if (!status.sample) {
      const detail = status.error
        ? `\n\n<pre>${escapeHtml(status.error)}</pre>`
        : '';
      return `You are subscribed, but the node is unreachable right now.${detail}`;
    }
    return formatMonitorStatus(
      {
        progressStepPercent: status.subscription.progressStepPercent,
        active: status.subscription.active,
        lastState: status.subscription.lastState,
        lastSentProgress: status.subscription.lastSentProgress,
        lastSentAt: status.subscription.lastSentAt,
      },
      status.sample,
    );
  }
}
