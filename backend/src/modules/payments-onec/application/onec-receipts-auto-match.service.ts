import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import type { DatabaseService } from '../../../database/database.service';
import type { OnecDocumentsEvents } from '../../onec-sync/application/onec-documents-events';
import type { PgOnecReceiptsCommandRepository } from '../adapters/pg-onec-receipts-command-repository';
import { RECEIPT_KINDS } from '../domain/onec-receipts';

export interface AutoMatchSettings {
  /** View + commands + `BACKEND_ONEC_PAYMENT_AUTO_MATCH` and the actor is configured. */
  enabled: boolean;
  /** `BACKEND_ONEC_PAYMENT_MATCH_ACTOR_USER_ID` (the `onec_sync_service` service account). */
  actorUserId: number | null;
}

export interface AutoMatchResult {
  passId: string;
  /** Pairs found by the read query. */
  candidates: number;
  /** Matches created. */
  matched: number;
  /** Another pass holds the lock — this one did nothing. */
  skipped: boolean;
}

/** Order filter of a pass started by the button: only orders in the initiator's `payments.update` scope (plan §6). */
export type OrderScope = (order: { orderId: number; createdBy: string | null; managerId: string | null }) => boolean;

const START_DELAY_MS = 60_000;
const INTERVAL_MS = 60 * 60_000;
/** After a loader pass: wait for the rest of the run's documents, one pass for all of them. */
const SIGNAL_DEBOUNCE_MS = 15_000;
const LOCK_KEY = 'payments-onec:auto-match';

/**
 * Auto-match of 1C receipts with ERP payments (plan 2026-10-04-onec-incoming-payments §5–6 «Автосверка»): after a
 * loader pass with receipts or 1C orders (in-process signal), every hour and a minute after start, and by the button.
 * Creates only match records (`origin = 'auto'`); never creates or changes payments or orders. One pass at a time
 * across backend instances (transaction advisory lock); every pair is its own transaction with the full locks.
 */
export class OnecReceiptsAutoMatcher {
  private readonly logger = new Logger(OnecReceiptsAutoMatcher.name);
  private startTimer: NodeJS.Timeout | null = null;
  private intervalTimer: NodeJS.Timeout | null = null;
  private signalTimer: NodeJS.Timeout | null = null;
  private unsubscribe: (() => void) | null = null;
  private running: Promise<AutoMatchResult> | null = null;

  constructor(private readonly ports: {
    database: DatabaseService;
    commands: PgOnecReceiptsCommandRepository;
    settings: () => AutoMatchSettings;
    events?: OnecDocumentsEvents;
  }) {}

  start(): void {
    const settings = this.ports.settings();
    if (!settings.enabled) {
      if (settings.actorUserId === null) this.logger.log('1C receipts auto-match: off (no actor or flag)');
      return;
    }
    this.startTimer = setTimeout(() => this.runInBackground('start'), START_DELAY_MS);
    this.intervalTimer = setInterval(() => this.runInBackground('hourly'), INTERVAL_MS);
    this.startTimer.unref?.();
    this.intervalTimer.unref?.();
    this.unsubscribe = this.ports.events?.onDocumentsLoaded((event) => {
      const relevant = event.docKinds.some((kind) => (RECEIPT_KINDS as readonly string[]).includes(kind) || kind === 'customer_order');
      if (!relevant) return;
      if (this.signalTimer) clearTimeout(this.signalTimer);
      this.signalTimer = setTimeout(() => this.runInBackground('loader'), SIGNAL_DEBOUNCE_MS);
      this.signalTimer.unref?.();
    }) ?? null;
  }

  stop(): void {
    for (const timer of [this.startTimer, this.signalTimer]) if (timer) clearTimeout(timer);
    if (this.intervalTimer) clearInterval(this.intervalTimer);
    this.unsubscribe?.();
    this.startTimer = this.intervalTimer = this.signalTimer = null;
    this.unsubscribe = null;
  }

  private runInBackground(trigger: string): void {
    const settings = this.ports.settings();
    if (!settings.enabled || settings.actorUserId === null) return;
    void this.run({ actorUserId: String(settings.actorUserId), trigger })
      .then((result) => {
        if (result.matched > 0 || result.candidates > 0) {
          this.logger.log(`1C receipts auto-match (${trigger}) ${result.passId}: ${result.matched} of ${result.candidates} matched`);
        }
      })
      .catch((error: unknown) => this.logger.error(`1C receipts auto-match (${trigger}) failed: ${error instanceof Error ? error.message : String(error)}`));
  }

  /**
   * One pass. `actorUserId` — the service account (background) or the initiator (button); `scope` — the button's order
   * filter. A pass already running in this process is joined; one running in another instance → `skipped`.
   */
  run(input: { actorUserId: string; trigger: string; scope?: OrderScope; correlationId?: string | null }): Promise<AutoMatchResult> {
    if (this.running && !input.scope) return this.running;
    const pass = this.pass(input).finally(() => {
      if (this.running === pass) this.running = null;
    });
    if (!input.scope) this.running = pass;
    return pass;
  }

  private async pass(input: { actorUserId: string; trigger: string; scope?: OrderScope; correlationId?: string | null }): Promise<AutoMatchResult> {
    const passId = randomUUID();
    return this.ports.database.transaction(async (lockTx) => {
      const { rows: [lock] } = await lockTx.query<{ got: boolean }>('SELECT pg_try_advisory_xact_lock(hashtext($1)) AS got', [LOCK_KEY]);
      if (!lock?.got) return { passId, candidates: 0, matched: 0, skipped: true };
      const pairs = (await this.ports.commands.autoMatchCandidates()).filter((pair) => !input.scope || input.scope(pair));
      let matched = 0;
      for (const pair of pairs) {
        try {
          const done = await this.ports.commands.autoMatchPair(pair.lineId, pair.paymentId, {
            userId: input.actorUserId, username: null, role: null, passId,
            requestId: `onec-auto-match-${passId}`, correlationId: input.correlationId ?? `onec-auto-match:${input.trigger}`,
          }, input.scope);
          if (done) matched += 1;
        } catch (error) {
          // One pair failing (a lock timeout, a concurrent change) does not stop the pass; the next pass retries it.
          this.logger.warn(`1C receipts auto-match ${passId}: line ${pair.lineId} skipped: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      return { passId, candidates: pairs.length, matched, skipped: false };
    });
  }
}
