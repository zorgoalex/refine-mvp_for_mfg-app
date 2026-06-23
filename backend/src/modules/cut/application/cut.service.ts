import { ApiError } from '../../../common/errors/api-error';
import type { CurrentUser } from '../../../permissions/current-user';
import type { PermissionName } from '../../../permissions/permissions';
import { PermissionsService } from '../../../permissions/permissions.service';
import type {
  AddCutItemsCommand,
  ArchiveCutJobCommand,
  CalculateCutJobCommand,
  CreateCutJobCommand,
  CutRepositoryPort,
  CutSheetTypeOption,
  DetailLastReadyQuery,
  DetailPlacementsQuery,
  EligibleDetailsQuery,
  GetCutJobQuery,
  ListCutJobsQuery,
  ListSheetTypesForCutQuery,
  RemoveCutItemCommand,
  RenderGroupPdfQuery,
  RenderJobPdfQuery,
  RenderSheetPngQuery,
  RenderSheetSvgQuery,
  SetCutJobProfileCommand,
  SetPdfPrewarmStateQuery,
} from './cut-command.types';

export interface CutServicePorts {
  cut: CutRepositoryPort;
  permissions?: PermissionsService;
}

/**
 * Backend owns the cut command/read API (CLAUDE.md principle 2). RBAC is checked
 * server-side (principle 8): reads require cut.view, mutations require
 * cut.manage. Frontend permission decisions are never authoritative.
 */
export class CutService {
  private readonly permissions: PermissionsService;

  constructor(private readonly ports: CutServicePorts) {
    this.permissions = ports.permissions ?? new PermissionsService();
  }

  async createJob(command: CreateCutJobCommand) {
    this.require(command.currentUser, 'cut.manage', { requestId: command.requestId });
    return this.ports.cut.createJob(command);
  }

  async addItems(command: AddCutItemsCommand) {
    this.require(command.currentUser, 'cut.manage', { cutJobId: command.cutJobId, requestId: command.requestId });
    return this.ports.cut.addItems(command);
  }

  async removeItem(command: RemoveCutItemCommand) {
    this.require(command.currentUser, 'cut.manage', { cutJobId: command.cutJobId, requestId: command.requestId });
    return this.ports.cut.removeItem(command);
  }

  async calculate(command: CalculateCutJobCommand) {
    this.require(command.currentUser, 'cut.manage', { cutJobId: command.cutJobId, requestId: command.requestId });
    return this.ports.cut.calculate(command);
  }

  async archive(command: ArchiveCutJobCommand) {
    this.require(command.currentUser, 'cut.manage', { cutJobId: command.cutJobId, requestId: command.requestId });
    return this.ports.cut.archive(command);
  }

  async getJob(query: GetCutJobQuery) {
    this.require(query.currentUser, 'cut.view', { cutJobId: query.cutJobId, requestId: query.requestId });
    return this.ports.cut.getJob(query);
  }

  async listJobs(query: ListCutJobsQuery) {
    this.require(query.currentUser, 'cut.view', { requestId: query.requestId });
    return this.ports.cut.listJobs(query);
  }

  async listEligibleDetails(query: EligibleDetailsQuery) {
    this.require(query.currentUser, 'cut.view', { requestId: query.requestId });
    return this.ports.cut.listEligibleDetails(query);
  }

  async listDetailPlacements(query: DetailPlacementsQuery) {
    this.require(query.currentUser, 'cut.view', { requestId: query.requestId });
    return this.ports.cut.listDetailPlacements(query);
  }

  async listDetailLastReady(query: DetailLastReadyQuery) {
    this.require(query.currentUser, 'cut.view', { requestId: query.requestId });
    return this.ports.cut.listDetailLastReady(query);
  }

  async renderSheetPng(query: RenderSheetPngQuery) {
    this.require(query.currentUser, 'cut.view', { requestId: query.requestId });
    return this.ports.cut.renderSheetPng(query);
  }

  async renderSheetSvg(query: RenderSheetSvgQuery) {
    this.require(query.currentUser, 'cut.view', { cutGroupId: query.cutGroupId, requestId: query.requestId });
    return this.ports.cut.renderSheetSvg(query);
  }

  async renderGroupPdf(query: RenderGroupPdfQuery) {
    this.require(query.currentUser, 'cut.view', { cutGroupId: query.cutGroupId, requestId: query.requestId });
    return this.ports.cut.renderGroupPdf(query);
  }

  async renderJobPdf(query: RenderJobPdfQuery) {
    this.require(query.currentUser, 'cut.view', { cutJobId: query.cutJobId, requestId: query.requestId });
    return this.ports.cut.renderJobPdf(query);
  }

  /** Internal pre-warm bookkeeping (no user-facing permission gate). */
  async setPdfPrewarmState(query: SetPdfPrewarmStateQuery) {
    return this.ports.cut.setPdfPrewarmState(query);
  }

  /**
   * Cut-gated sheet-type lookup for the /cut filter (Variant B Task 11).
   * Gated on cut.view ONLY — independent of sheet_materials.view or order perms.
   * This lets worker (cut.view, no sheet_materials.view) populate the cut filter.
   */
  async listSheetTypesForCut(query: ListSheetTypesForCutQuery): Promise<CutSheetTypeOption[]> {
    this.require(query.currentUser, 'cut.view', { requestId: query.requestId });
    return this.ports.cut.listSheetTypesForCut(query);
  }

  async setProfile(command: SetCutJobProfileCommand) {
    this.require(command.currentUser, 'cut.manage', { cutJobId: command.cutJobId, requestId: command.requestId });
    return this.ports.cut.setProfile(command);
  }

  private require(
    currentUser: CurrentUser | null | undefined,
    permission: PermissionName,
    ctx?: { cutJobId?: number; cutGroupId?: number; requestId?: string },
  ): void {
    if (this.permissions.canUser(currentUser, permission)) {
      return;
    }
    // Audited RBAC denial (plan §11). Best-effort + fire-and-forget so the audit
    // write never masks or delays the 403. Only when we have an actor to attribute.
    if (currentUser) {
      void this.ports.cut
        .recordPermissionDenied({
          currentUser,
          requiredPermissions: [permission],
          requestId: ctx?.requestId,
          cutJobId: ctx?.cutJobId,
        })
        .catch(() => undefined);
    }
    throw new ApiError(403, 'PERMISSION_DENIED', 'Недостаточно прав для выполнения действия', {
      requiredPermissions: [permission],
    });
  }
}
