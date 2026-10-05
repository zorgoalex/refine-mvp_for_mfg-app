import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { ApiError } from '../../../common/errors/api-error';
import { DatabaseService } from '../../../database/database.service';
import type { CurrentUser } from '../../../permissions/current-user';
import { OrderSendRepository, assertSameCommand, type SendRow } from './order-send.repository';
import { toView } from './order-send.service';
import { OrderSendWorker } from './order-send-worker.service';
import type { OrderSendView, SupplierSendMenu } from './order-send.types';
import { SupplierSendRepository, type SupplierSendCommand } from './supplier-send.repository';

/** Refusals worth a refused-audit row and a technical trace (a final one is audited in its own transaction). */
const REFUSALS = new Set(['ORDER_SEND_ALREADY_QUEUED', 'ORDER_SEND_QUEUE_FULL', 'ORDER_SEND_PAUSED', 'ORDER_SEND_PREVIOUS_UNKNOWN',
  'SUPPLIER_SEND_DISABLED', 'SUPPLIER_REQUEST_SCOPE', 'PROCUREMENT_ACTOR_INVALID']);

/** «Отправить в WhatsApp» in the window «Текст для поставщика» of the procurement screen. */
@Injectable()
export class SupplierSendService {
  constructor(
    @Inject(SupplierSendRepository) private readonly repository: SupplierSendRepository,
    @Inject(OrderSendRepository) private readonly sends: OrderSendRepository,
    @Inject(OrderSendWorker) private readonly worker: OrderSendWorker,
    @Inject(DatabaseService) private readonly database: DatabaseService,
  ) {}

  async menu(supplierRequestId: number, actor: CurrentUser): Promise<SupplierSendMenu> {
    return { ...await this.repository.menu(actor, supplierRequestId), runtime: this.worker.runtime() };
  }

  async send(command: SupplierSendCommand, actor: CurrentUser, requestId: string): Promise<{ send: OrderSendView }> {
    const fingerprint = createHash('sha256').update(JSON.stringify({
      kind: 'supplier_request', supplierRequestId: command.supplierRequestId,
      textSha256: createHash('sha256').update(command.text).digest('hex'), edited: command.edited,
      templateId: command.templateId, templateVersion: command.templateVersion, textVersion: command.textVersion,
      contactId: command.contactId, contactToken: command.contactToken, confirmAfterUnknown: command.confirmAfterUnknown,
    })).digest('hex');
    try {
      // Access first (no ledger oracle for a foreign request), then the ledger before anything else:
      // a lost response is replayed even if WhatsApp, the request or the settings changed since.
      await this.repository.assertAccess(actor, command.supplierRequestId);
      const committed = await this.sends.findCommand(this.database, actor.id, command.idempotencyKey);
      if (committed) return { send: await this.view(assertSameCommand(committed, fingerprint)) };
      const runtime = this.worker.runtime();
      if (!runtime.relayAvailable) throw new ApiError(503, 'BROADCAST_RUNTIME_UNAVAILABLE', runtime.unavailableReason ?? 'WhatsApp relay is unavailable');
      const outcome = await this.repository.enqueue(command, actor, requestId, fingerprint);
      if (!outcome.replayed) void this.worker.kick();
      return { send: await this.view(outcome.row) };
    } catch (error) {
      if (error instanceof ApiError) {
        const final = (error.details as { final?: unknown } | undefined)?.final === true;
        if (REFUSALS.has(error.code) && !final) await this.repository.recordRefusal(command, actor, requestId, error.code).catch(() => undefined);
        if (REFUSALS.has(error.code) || final) {
          await this.worker.logRefusal(error.code, { supplierRequestId: command.supplierRequestId, targetKind: 'supplier' });
        }
      }
      throw error;
    }
  }

  private async view(fallback: SendRow): Promise<OrderSendView> {
    const row = (await this.sends.getSend(fallback.send_id)) ?? fallback;
    const estimate = row.state === 'queued' || row.state === 'sending' ? (await this.sends.queueSnapshot()).estimates.get(row.send_id) : undefined;
    return toView(row, estimate);
  }
}
