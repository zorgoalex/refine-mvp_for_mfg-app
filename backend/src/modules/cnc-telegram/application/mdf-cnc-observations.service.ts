import type { CurrentUser } from '../../../permissions/current-user';
import type { CncTelegramWorkerSessionLeaseContext } from './cnc-telegram-worker-session.types';
import type { CncTelegramWorkerSessionService } from './cnc-telegram-worker-session.service';
import type {
  CncTelegramMdfObservationRepositoryPort,
  MdfCncObservationClaimDto,
  MdfCncObservationFailureReason,
  MdfCncObservationReport,
  MdfCncObservationResult,
} from './mdf-cnc-observations.types';

export class CncTelegramMdfObservationService {
  constructor(
    private readonly repository: CncTelegramMdfObservationRepositoryPort,
    private readonly session: CncTelegramWorkerSessionService,
  ) {}

  async claim(currentUser: CurrentUser, lease: CncTelegramWorkerSessionLeaseContext): Promise<{ claim: MdfCncObservationClaimDto | null }> {
    const authorizedLease = this.authorizedLease(lease);
    await this.session.assertCurrent(currentUser, authorizedLease);
    const claim = await this.repository.claim({ currentUser, lease: authorizedLease });
    return { claim };
  }

  async complete(input: {
    currentUser: CurrentUser;
    lease: CncTelegramWorkerSessionLeaseContext;
    report: MdfCncObservationReport;
    requestId: string;
  }): Promise<MdfCncObservationResult> {
    const authorizedLease = this.authorizedLease(input.lease);
    await this.session.assertCurrent(input.currentUser, authorizedLease);
    return this.repository.complete({ ...input, lease: authorizedLease });
  }

  async fail(input: {
    currentUser: CurrentUser;
    lease: CncTelegramWorkerSessionLeaseContext;
    claimId: string;
    claimToken: string;
    claimGeneration: number;
    reason: MdfCncObservationFailureReason;
    requestId: string;
  }): Promise<{ failed: true }> {
    const authorizedLease = this.authorizedLease(input.lease);
    await this.session.assertCurrent(input.currentUser, authorizedLease);
    await this.repository.fail({ ...input, lease: authorizedLease });
    return { failed: true };
  }

  private authorizedLease(lease: CncTelegramWorkerSessionLeaseContext): CncTelegramWorkerSessionLeaseContext {
    return { ...lease, sourceChatId: this.session.resolveChatId(lease.sourceChatId) };
  }
}
