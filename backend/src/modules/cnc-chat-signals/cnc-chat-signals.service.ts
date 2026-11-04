import { randomUUID } from 'node:crypto';
import type { ConfigService } from '@nestjs/config';
import { ApiError } from '../../common/errors/api-error';
import type { BackendEnv } from '../../config/env.validation';
import type { CurrentUser } from '../../permissions/current-user';
import { PermissionsService } from '../../permissions/permissions.service';
import type { PermissionName } from '../../permissions/permissions';
import type { CncTelegramWorkerSessionService } from '../cnc-telegram/application/cnc-telegram-worker-session.service';
import type { CncTelegramWorkerSessionLeaseContext } from '../cnc-telegram/application/cnc-telegram-worker-session.types';
import { confirmResultOf, type PgCncChatSignalsRepository } from './pg-cnc-chat-signals-repository';
import type {
  SawnSignalApplyConfirmDto, SawnSignalClaimResponse, SawnSignalConfirmResult, SawnSignalListQuery,
  SawnSignalListResponse, SawnSignalPreviewItem, SawnSignalPreviewRequestDto, SawnSignalReportDto,
  SawnSignalSettingsDto, SawnSignalSettingsUpdateDto,
} from './cnc-chat-signals.dto';

const FOLLOW_UP_APPLIES = 20;
const FOLLOW_UP_RESETS = 20;

/** «Распилено» signals from the CNC chat: worker claim/report, follow-up application, journal and user commands. */
export class CncChatSignalsService {
  private readonly permissions = new PermissionsService();

  constructor(
    private readonly repository: PgCncChatSignalsRepository,
    private readonly config: ConfigService<BackendEnv, true>,
    private readonly session: CncTelegramWorkerSessionService,
  ) {}

  async claim(currentUser: CurrentUser, requestId: string, lease: CncTelegramWorkerSessionLeaseContext): Promise<SawnSignalClaimResponse> {
    const resolved = await this.assertWorker(currentUser, lease);
    return this.repository.claim({ currentUser, lease: resolved, requestId });
  }

  async report(input: { currentUser: CurrentUser; requestId: string; lease: CncTelegramWorkerSessionLeaseContext;
    report: SawnSignalReportDto }): Promise<{ accepted: true; replay: boolean }> {
    const lease = await this.assertWorker(input.currentUser, input.lease);
    const result = await this.repository.report({ currentUser: input.currentUser, lease, requestId: input.requestId,
      report: input.report });
    // The journal is committed; production effects run in their own boundary-first transactions (F13).
    await this.runFollowUps(input.currentUser, input.requestId);
    return { accepted: true, replay: result.replay };
  }

  /** Automatic application and return-barrier resets; failures stay retryable and never undo the journal. */
  private async runFollowUps(actor: CurrentUser, requestId: string): Promise<void> {
    for (const packetSignalId of await this.repository.dueAutoApplies(FOLLOW_UP_APPLIES)) {
      try {
        await this.repository.applySignal({ packetSignalId, mode: 'auto', actor, requestId,
          idempotencyKey: `cnc-chat-signal:${packetSignalId}` });
      } catch (error) {
        console.error(`cnc chat signal ${packetSignalId} apply failed`, error);
      }
    }
    for (const resetId of await this.repository.dueReturnResets(FOLLOW_UP_RESETS)) {
      try {
        await this.repository.runReturnReset({ resetId, actor, requestId });
      } catch (error) {
        console.error(`cnc chat signal return reset ${resetId} failed`, error);
      }
    }
  }

  async list(currentUser: CurrentUser, query: SawnSignalListQuery): Promise<SawnSignalListResponse> {
    this.require(currentUser, 'audit.view');
    return this.repository.list(query);
  }

  async getSettings(currentUser: CurrentUser): Promise<SawnSignalSettingsDto> {
    if (!this.permissions.canUser(currentUser, 'cut.manage') && !this.permissions.canUser(currentUser, 'audit.view')) {
      throw new ApiError(403, 'PERMISSION_DENIED', 'Недостаточно прав', { requiredPermissions: ['cut.manage', 'audit.view'] });
    }
    return this.repository.settings();
  }

  async setSettings(currentUser: CurrentUser, dto: SawnSignalSettingsUpdateDto, requestId: string): Promise<SawnSignalSettingsDto> {
    this.require(currentUser, 'cut.manage');
    return this.repository.setApplyToPacket({ actor: currentUser, applyToPacket: dto.applyToPacket,
      idempotencyKey: dto.idempotencyKey, requestId });
  }

  async preview(currentUser: CurrentUser, dto: SawnSignalPreviewRequestDto, requestId: string): Promise<{ items: SawnSignalPreviewItem[] }> {
    this.require(currentUser, 'cut.manage');
    const candidates = await this.repository.manualCandidates(dto.packetSignalIds);
    const items: SawnSignalPreviewItem[] = [];
    for (const candidate of candidates) {
      const outcome = await this.repository.applySignal({ packetSignalId: candidate.packetSignalId, mode: 'preview',
        actor: currentUser, requestId, idempotencyKey: `cnc-chat-signal:${candidate.packetSignalId}` });
      if (outcome.result === 'preview') {
        items.push({ ...candidate, applyState: outcome.applyState, eligible: outcome.eligible,
          blockedReason: outcome.reason, effect: outcome.effect, effectDigest: outcome.effectDigest });
      } else {
        items.push({ ...candidate, eligible: false,
          blockedReason: outcome.result === 'blocked' || outcome.result === 'held' ? outcome.reason : 'read_only',
          effect: { details: [], orders: [], events: [] }, effectDigest: '' });
      }
    }
    await this.repository.recordPreviewAudit({ actor: currentUser, requestId, items });
    return { items };
  }

  async confirm(currentUser: CurrentUser, dto: SawnSignalApplyConfirmDto, requestId: string): Promise<{ results: SawnSignalConfirmResult[] }> {
    this.require(currentUser, 'cut.manage');
    return this.repository.confirmCommand({
      actor: currentUser, dto, requestId,
      applyItem: async (item, commandItem) => confirmResultOf(item.packetSignalId,
        await this.repository.applySignal({ packetSignalId: item.packetSignalId, mode: 'manual', actor: currentUser,
          requestId, expectedDigest: item.effectDigest, idempotencyKey: `cnc-chat-signal:${item.packetSignalId}`,
          commandItem })),
    });
  }

  newRequestId(): string {
    return `cnc-chat-signal:${randomUUID()}`;
  }

  private require(currentUser: CurrentUser, permission: PermissionName): void {
    if (!this.permissions.canUser(currentUser, permission)) {
      throw new ApiError(403, 'PERMISSION_DENIED', 'Недостаточно прав', { requiredPermissions: [permission] });
    }
  }

  private async assertWorker(currentUser: CurrentUser, lease: CncTelegramWorkerSessionLeaseContext): Promise<CncTelegramWorkerSessionLeaseContext> {
    const configuredUsername = this.config.get('CNC_TELEGRAM_WORKER_USERNAME', { infer: true });
    const allowedChats = (this.config.get('CNC_TELEGRAM_ALLOWED_CHAT_IDS', { infer: true }) ?? '')
      .split(',').map((value) => value.trim()).filter(Boolean);
    if (!configuredUsername || allowedChats.length === 0) {
      throw new ApiError(503, 'CNC_TELEGRAM_WORKER_POLICY_UNCONFIGURED', 'Политика Telegram-воркера не настроена');
    }
    if (!this.permissions.canUser(currentUser, 'cut.manage') || currentUser.username !== configuredUsername) {
      throw new ApiError(403, 'PERMISSION_DENIED', 'Недостаточно прав для опроса сигналов чата', {
        requiredPermissions: ['cut.manage'],
      });
    }
    await this.session.assertCurrent(currentUser, lease);
    const resolved = { ...lease, sourceChatId: this.session.resolveChatId(lease.sourceChatId) };
    if (!allowedChats.includes(resolved.sourceChatId)) {
      throw new ApiError(403, 'PERMISSION_DENIED', 'Чат не разрешён для Telegram-воркера');
    }
    return resolved;
  }
}
