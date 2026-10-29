import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { BackendEnv } from '../../config/env.validation';
import { OnecEtlEvents, type EntitiesPublished } from '../onec-agent/application/onec-etl-events';
import { DuplicateEngineRepository, errorCode } from './duplicate-engine.repository';
import { DUPLICATE_RULES, ONEC_RULES, type DuplicateRule } from './duplicate-rules';
import type { CheckContext } from './integration-duplicates';

const QUEUE_EVERY_MS = 10_000;
const MAINTENANCE_EVERY_MS = 15 * 60_000;
const HOURLY_MS = 60 * 60_000;
const FIRST_PASS_DELAY_MS = 2 * 60_000;
/** The nightly pass of the ERP directories runs in this UTC hour (outside the 1C windows). */
const NIGHTLY_UTC_HOUR = 2;
/** Publications of these 1C sets can change what the rules reading 1C find. */
const ONEC_ENTITIES = new Set(['counterparties', 'counterparty_phones', 'counterparty_contacts', 'items']);

/**
 * The background side of the journal of duplicates. Behind BACKEND_INTEGRATION_DUPLICATES: checks of records queued
 * by the triggers of the directories and by publications of 1C (every 10 s), a first full pass two minutes after the
 * start, the rules reading 1C every hour (the publication signal is best effort), the ERP directories every night.
 * Always, with the search on or off: the cleanup of keys read from 1C sets that were revoked or expired (every 15
 * minutes and at the start), and of requests nobody takes. One round of each kind at a time in this process.
 */
@Injectable()
export class IntegrationDuplicatesService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(IntegrationDuplicatesService.name);
  private readonly timers: NodeJS.Timeout[] = [];
  private unsubscribe: (() => void) | null = null;
  private queueBusy = false;
  private passBusy = false;
  private maintenanceBusy = false;
  private lastNightly: string | null = null;

  constructor(
    @Inject(ConfigService) private readonly config: ConfigService<BackendEnv, true>,
    @Inject(DuplicateEngineRepository) private readonly engine: DuplicateEngineRepository,
    @Inject(OnecEtlEvents) private readonly events: OnecEtlEvents,
  ) {}

  enabled(): boolean {
    return this.config.get('BACKEND_INTEGRATION_DUPLICATES', { infer: true }) === true;
  }

  onModuleInit(): void {
    this.every(MAINTENANCE_EVERY_MS, () => this.maintenance());
    this.after(5_000, () => this.maintenance());
    if (!this.enabled()) return;
    this.unsubscribe = this.events.onEntitiesPublished((event) => this.onPublished(event));
    this.every(QUEUE_EVERY_MS, () => this.drain());
    this.after(FIRST_PASS_DELAY_MS, () => this.pass(DUPLICATE_RULES, 'start'));
    this.every(HOURLY_MS, () => this.hourly());
  }

  onModuleDestroy(): void {
    this.unsubscribe?.();
    for (const timer of this.timers) clearTimeout(timer);
  }

  private every(ms: number, task: () => Promise<unknown>): void {
    const timer = setInterval(() => void task(), ms);
    timer.unref?.();
    this.timers.push(timer);
  }

  private after(ms: number, task: () => Promise<unknown>): void {
    const timer = setTimeout(() => void task(), ms);
    timer.unref?.();
    this.timers.push(timer);
  }

  /** Only a request in the queue: the signal comes after the commit of 1C and must not do the work itself. */
  private onPublished(event: EntitiesPublished): void {
    if (!event.entities.some((entity) => ONEC_ENTITIES.has(entity))) return;
    void this.engine.enqueue('onec_counterparty', 'onec', '*', 'onec_publication', event.correlationId)
      .catch((error: unknown) => this.logger.error(`duplicates: 1C publication not queued: ${errorCode(error)}`));
  }

  private async hourly(): Promise<void> {
    const now = new Date();
    const day = now.toISOString().slice(0, 10);
    if (now.getUTCHours() === NIGHTLY_UTC_HOUR && this.lastNightly !== day) {
      this.lastNightly = day;
      await this.pass(DUPLICATE_RULES, 'nightly');
    } else {
      await this.pass(ONEC_RULES, 'hourly');
    }
  }

  /** One round of the queue; never throws (a background boundary). */
  async drain(): Promise<number> {
    if (!this.enabled() || this.queueBusy) return 0;
    this.queueBusy = true;
    let done = 0;
    try {
      await this.engine.ensureKey();
      const claim = await this.engine.claim();
      for (const record of claim.records) {
        const check: CheckContext = {
          via: record.via, requestId: `integration-duplicates:${randomUUID()}`,
          correlationId: record.correlationId ?? `integration-duplicates:${randomUUID()}`, authorUserId: record.authorUserId,
        };
        try {
          // `*` — a whole 1C publication: every rule reading 1C runs over all records.
          if (record.ref.recordKey === '*') {
            const result = await this.engine.fullPass(ONEC_RULES, check);
            // A pass with failed cases is not done: the request comes back later with the error kept.
            if (result.failed > 0) throw Object.assign(new Error('pass of 1C rules had failures'), { code: result.lastError ?? 'PASS_FAILED' });
          } else await this.engine.checkRecord(record.ref, check);
          await this.engine.acknowledge(claim.leaseId, record.requestIds, record.ref);
          done += 1;
        } catch (error) {
          this.logger.error(`duplicates: check of ${record.ref.entityKind} ${record.ref.recordKey} failed: ${errorCode(error)}`);
          await this.engine.release(claim.leaseId, record.requestIds, record.ref, errorCode(error))
            .catch((releaseError: unknown) => this.logger.error(`duplicates: release failed: ${errorCode(releaseError)}`));
        }
      }
    } catch (error) {
      this.logger.error(`duplicates: queue round failed: ${errorCode(error)}`);
    } finally {
      this.queueBusy = false;
    }
    return done;
  }

  /** A full pass of some rules; never throws. */
  async pass(rules: readonly DuplicateRule[], reason: 'start' | 'hourly' | 'nightly'): Promise<void> {
    if (!this.enabled() || this.passBusy) return;
    this.passBusy = true;
    const correlationId = `integration-duplicates-pass:${reason}:${randomUUID()}`;
    try {
      await this.engine.ensureKey();
      const result = await this.engine.fullPass(rules, { via: 'scan', requestId: correlationId, correlationId, authorUserId: null });
      if (result.changed || result.failed) this.logger.log(`duplicates pass (${reason}): ${JSON.stringify(result)}`);
    } catch (error) {
      this.logger.error(`duplicates pass (${reason}) failed: ${errorCode(error)}`);
    } finally {
      this.passBusy = false;
    }
  }

  /** Cleanup of keys read from revoked or expired 1C sets; runs with the search off too. Never throws. */
  async maintenance(): Promise<void> {
    if (this.maintenanceBusy) return;
    this.maintenanceBusy = true;
    const correlationId = `integration-duplicates-maintenance:${randomUUID()}`;
    try {
      if (!(await this.engine.installed())) return;
      const worst = new Map<number, string>();
      const order = ['current', 'replaced', 'expired', 'missing', 'revoked'];
      for (const { caseId, state } of await this.engine.sourceStates()) {
        if (order.indexOf(state) > order.indexOf(worst.get(caseId) ?? 'current')) worst.set(caseId, state);
      }
      const check: CheckContext = { via: 'scan', requestId: correlationId, correlationId, authorUserId: null };
      for (const [caseId, state] of worst) {
        try {
          if (state === 'replaced') await this.engine.requeueMembers(caseId, correlationId);
          else await this.engine.purgeCase(caseId, check);
        } catch (error) {
          this.logger.error(`duplicates: cleanup of case ${caseId} failed: ${errorCode(error)}`);
        }
      }
      if (!this.enabled()) await this.engine.dropStaleRequests();
    } catch (error) {
      this.logger.error(`duplicates maintenance failed: ${errorCode(error)}`);
    } finally {
      this.maintenanceBusy = false;
    }
  }
}
