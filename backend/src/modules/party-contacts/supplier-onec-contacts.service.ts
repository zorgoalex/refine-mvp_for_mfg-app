import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { BackendEnv } from '../../config/env.validation';
import { ApiError } from '../../common/errors/api-error';
import type { CurrentUser } from '../../permissions/current-user';
import { OnecEtlEvents, type EntitiesPublished } from '../onec-agent/application/onec-etl-events';
import {
  SupplierOnecContactsRepository, type OnecOwner, type OnecSyncOutcome, type SupplierSyncOutcome, type SyncContext, type SyncTrigger,
} from './supplier-onec-contacts.repository';

const HOURLY_MS = 60 * 60_000;
const FIRST_PASS_DELAY_MS = 90_000;
/** Publications that may change what an owner gets from 1C: its contacts and the counterparty itself (name, ИИН/БИН, marks). */
const ENTITIES = new Set(['counterparty_contacts', 'counterparties']);
const OWNERS: readonly OnecOwner[] = ['supplier', 'client'];

const describe = (error: unknown): string =>
  error instanceof ApiError ? error.code : error instanceof Error ? `${error.name}: ${error.message.slice(0, 300)}` : 'unknown error';

/**
 * Contacts of suppliers (K4a, BACKEND_PARTY_CONTACTS_ONEC_SYNC) and clients (K4b, BACKEND_CLIENT_ONEC_CONTACTS_SYNC)
 * from 1C: after a publication of the 1C contacts or counterparties (the in-process signal is best effort), a first pass
 * after start and an hourly pass; an owner on demand (the card button, a link change). One pass at a time in this
 * process; a request during a pass runs one more pass after it. A failure of one owner does not stop the others.
 */
@Injectable()
export class SupplierOnecContactsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SupplierOnecContactsService.name);
  private unsubscribe: (() => void) | null = null;
  private firstPass: NodeJS.Timeout | null = null;
  private hourly: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  /** Passes asked for while one runs, each with its own trigger and correlation (a publication keeps its run's id). */
  private readonly pending: Array<{ trigger: SyncTrigger; correlationId: string }> = [];

  constructor(
    @Inject(ConfigService) private readonly config: ConfigService<BackendEnv, true>,
    @Inject(SupplierOnecContactsRepository) private readonly repository: SupplierOnecContactsRepository,
    @Inject(OnecEtlEvents) private readonly events: OnecEtlEvents,
  ) {}

  /** Suppliers (K4a). */
  enabled(): boolean {
    return this.config.get('BACKEND_PARTY_CONTACTS_ONEC_SYNC', { infer: true }) === true;
  }

  /** Clients (K4b). */
  clientsEnabled(): boolean {
    return this.config.get('BACKEND_CLIENT_ONEC_CONTACTS_SYNC', { infer: true }) === true;
  }

  private ownerEnabled(party: OnecOwner): boolean {
    return party === 'supplier' ? this.enabled() : this.clientsEnabled();
  }

  onModuleInit(): void {
    if (!this.enabled() && !this.clientsEnabled()) return;
    this.unsubscribe = this.events.onEntitiesPublished((event) => this.onPublished(event));
    this.firstPass = setTimeout(() => void this.pass('hourly'), FIRST_PASS_DELAY_MS);
    this.firstPass.unref?.();
    this.hourly = setInterval(() => void this.pass('hourly'), HOURLY_MS);
    this.hourly.unref?.();
  }

  onModuleDestroy(): void {
    this.unsubscribe?.();
    if (this.firstPass) clearTimeout(this.firstPass);
    if (this.hourly) clearInterval(this.hourly);
  }

  private onPublished(event: EntitiesPublished): void {
    if (event.entities.some((entity) => ENTITIES.has(entity))) void this.pass('published', event.correlationId);
  }

  /** A whole pass over the enabled owners; never throws (a background boundary). */
  async pass(trigger: SyncTrigger, correlationId?: string): Promise<void> {
    if (!this.enabled() && !this.clientsEnabled()) return;
    const request = { trigger, correlationId: correlationId ?? `party-contacts-onec:${randomUUID()}` };
    // An hourly pass already waiting covers another hourly one; every publication gets its own pass.
    if (!(trigger === 'hourly' && this.pending.some((item) => item.trigger === 'hourly'))) this.pending.push(request);
    if (this.running) return this.running;
    this.running = (async () => {
      for (let next = this.pending.shift(); next; next = this.pending.shift()) {
        for (const party of OWNERS) if (this.ownerEnabled(party)) await this.passOnce(party, next.trigger, next.correlationId);
      }
    })().finally(() => { this.running = null; });
    return this.running;
  }

  private async passOnce(party: OnecOwner, trigger: SyncTrigger, correlationId: string): Promise<void> {
    const startedAt = new Date();
    const counts = { processed: 0, changed: 0, failed: 0 };
    let lastError: string | null = null;
    try {
      for (const ownerId of await this.repository.targets(party)) {
        const ctx: SyncContext = { trigger, requestId: `party-contacts-onec:${randomUUID()}`, correlationId, actor: null };
        try {
          const outcome = await this.repository.syncOwner(party, ownerId, ctx);
          if (outcome.status === 'skipped' && outcome.reason === 'mirror_unavailable') break;
          counts.processed += 1;
          if (outcome.status === 'changed') counts.changed += 1;
        } catch (error) {
          counts.failed += 1;
          lastError = describe(error);
          this.logger.error(`1C contacts of ${party} ${ownerId} failed: ${lastError}`);
        }
      }
    } catch (error) {
      lastError = describe(error);
      this.logger.error(`1C contacts pass (${party}) failed: ${lastError}`);
    }
    try {
      await this.repository.recordPass(trigger, startedAt, counts, lastError, party);
    } catch (error) {
      this.logger.error(`1C contacts pass state (${party}) not saved: ${describe(error)}`);
    }
    if (counts.changed || counts.failed) this.logger.log(`1C contacts of ${party === 'supplier' ? 'suppliers' : 'clients'} (${trigger}): ${JSON.stringify(counts)}`);
  }

  /** One supplier now, by a user (the card button or after a link change). */
  async syncSupplier(supplierId: number, actor: CurrentUser, requestId: string, trigger: 'manual' | 'link'): Promise<SupplierSyncOutcome> {
    if (!this.enabled()) throw new ApiError(409, 'PARTY_CONTACTS_ONEC_SYNC_OFF', 'Сверка контактов с 1С выключена');
    return this.repository.sync(supplierId, { trigger, requestId, correlationId: requestId, actor });
  }

  /** One client now, by a user (the card button). */
  async syncClient(clientId: number, actor: CurrentUser, requestId: string): Promise<OnecSyncOutcome> {
    if (!this.clientsEnabled()) throw new ApiError(409, 'PARTY_CONTACTS_ONEC_SYNC_OFF', 'Сверка контактов с 1С выключена');
    return this.repository.syncClient(clientId, { trigger: 'manual', requestId, correlationId: requestId, actor });
  }

  /**
   * After a committed link change of clients (the card, the bulk confirmation, a merge or its undo): their copies follow
   * the new link now, in the background. A failure is only logged — the hourly pass repeats it.
   */
  syncClientsSoon(clientIds: readonly number[], actor: CurrentUser, requestId: string): void {
    if (!this.clientsEnabled() || !clientIds.length) return;
    void (async () => {
      for (const clientId of [...new Set(clientIds)]) {
        try {
          await this.repository.syncClient(clientId, { trigger: 'link', requestId, correlationId: requestId, actor });
        } catch (error) {
          this.logger.error(`1C contacts of client ${clientId} after a link change failed: ${describe(error)}`);
        }
      }
    })();
  }
}
