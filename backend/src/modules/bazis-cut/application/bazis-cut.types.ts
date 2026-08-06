import type { CurrentUser } from '../../../permissions/current-user';
import type {
  BazisCutDetailFields,
  BazisCutMutationResultDto,
  BazisCutOrderMembershipsDto,
  BazisCutPickerCriteria,
  BazisCutPickerFacetsDto,
  BazisCutPickerSearchDto,
  BazisCutSetDto,
  BazisCutSetListDto,
} from '../dto/bazis-cut.dto';

export interface BazisCutContext {
  currentUser: CurrentUser;
  requestId?: string;
}

export interface CreateBazisCutSetCommand extends BazisCutContext {
  /** Accepted only for rolling compatibility; the backend owns generated names. */
  name?: string;
  orderId: number;
  detailIds: number[];
  idempotencyKey: string;
}

export interface AddBazisCutDetailsCommand extends BazisCutContext {
  setId: number;
  orderId: number;
  detailIds: number[];
  expectedVersion: number;
  idempotencyKey: string;
}

export interface CreateBazisCutSetFromPickerCommand extends BazisCutContext {
  criteria: BazisCutPickerCriteria;
  criteriaHash: string;
  details: Array<{ detailId: number; selectionToken: string }>;
  idempotencyKey: string;
}

export interface RenameBazisCutSetCommand extends BazisCutContext {
  setId: number;
  name: string;
  expectedVersion: number;
  idempotencyKey: string;
}

export interface UpdateBazisCutDetailCommand extends BazisCutContext {
  setId: number;
  detailId: number;
  expectedVersion: number;
  fields: BazisCutDetailFields;
  idempotencyKey: string;
}

export interface DeleteBazisCutDetailCommand extends BazisCutContext {
  setId: number;
  detailId: number;
  expectedVersion: number;
  idempotencyKey: string;
}

export interface BazisCutRepositoryPort {
  list(input: BazisCutContext & { search: string; page: number; pageSize: number }): Promise<BazisCutSetListDto>;
  get(input: BazisCutContext & { setId: number }): Promise<BazisCutSetDto>;
  create(command: CreateBazisCutSetCommand): Promise<BazisCutMutationResultDto>;
  pickerFacets(input: BazisCutContext & Pick<BazisCutPickerCriteria, 'dateFrom' | 'dateTo'>): Promise<BazisCutPickerFacetsDto>;
  pickerSearch(input: BazisCutContext & {
    criteria: BazisCutPickerCriteria;
    page: number;
    pageSize: number;
  }): Promise<BazisCutPickerSearchDto>;
  createFromPicker(command: CreateBazisCutSetFromPickerCommand): Promise<BazisCutMutationResultDto>;
  orderMemberships(input: BazisCutContext & { orderId: number }): Promise<BazisCutOrderMembershipsDto>;
  rename(command: RenameBazisCutSetCommand): Promise<BazisCutMutationResultDto>;
  addDetails(command: AddBazisCutDetailsCommand): Promise<BazisCutMutationResultDto>;
  updateDetail(command: UpdateBazisCutDetailCommand): Promise<BazisCutMutationResultDto>;
  deleteDetail(command: DeleteBazisCutDetailCommand): Promise<BazisCutMutationResultDto>;
  export(input: BazisCutContext & { setId: number; templateId?: number }): Promise<{ set: BazisCutSetDto; bytes: Buffer }>;
}
