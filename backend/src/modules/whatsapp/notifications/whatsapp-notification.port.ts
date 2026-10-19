import { Inject, Injectable } from '@nestjs/common';
import type { DatabaseClient } from '../../../database/database.types';
import { WhatsAppRuntimeConfigService } from '../whatsapp-runtime-config.service';
import { WhatsAppNotificationRepository, type CancelRef } from './whatsapp-notification.repository';
import type { WhatsAppNotificationRequest, WhatsAppNotificationResult, WhatsAppNotificationState, WhatsAppNotificationStatus } from './whatsapp-notification.types';

/**
 * The WhatsApp notification channel for backend modules (first consumer — 1C alerts). `enqueue` and `cancel` run
 * in the caller's transaction and take, first of all, the delivery epoch FOR SHARE; the caller must not hold
 * permissions_state, users, roles, employees or employee_work_contacts for write when calling them.
 * Who and when is the consumer's business; the channel delivers: recipient and permission re-checked before
 * sending, pause, frequency gate, at most once, audit, lifetime. This module never imports 1C modules.
 */
@Injectable()
export class WhatsAppNotificationPort {
  /** Time of a decision (tests move it). */
  clock: () => Date = () => new Date();

  constructor(
    @Inject(WhatsAppNotificationRepository) private readonly repository: WhatsAppNotificationRepository,
    @Inject(WhatsAppRuntimeConfigService) private readonly runtimeConfig: WhatsAppRuntimeConfigService,
  ) {}

  /** Queues one message, or records why it is skipped. A repeat of the key returns the same delivery. */
  enqueue(tx: DatabaseClient, request: WhatsAppNotificationRequest): Promise<WhatsAppNotificationResult> {
    const config = this.runtimeConfig.getConfig();
    // Not deliverable by this process (stage, flags off): skipped at once, so nothing piles up for later.
    return this.repository.enqueue(tx, request, config.enabled && config.relayOwner === 'in_process', this.clock());
  }

  /** Cancels a delivery that has not started; a started or finished one is returned as it is. Null — no such delivery. */
  cancel(tx: DatabaseClient, ref: CancelRef): Promise<{ deliveryId: string; state: WhatsAppNotificationState; cancelled: boolean } | null> {
    return this.repository.cancel(tx, ref, this.clock());
  }

  statuses(client: DatabaseClient, deliveryIds: readonly string[]): Promise<WhatsAppNotificationStatus[]> {
    return this.repository.statuses(client, deliveryIds);
  }
}
