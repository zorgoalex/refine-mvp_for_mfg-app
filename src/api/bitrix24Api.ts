import { apiRoutes } from './apiRoutes';
import { httpClient } from './httpClient';

export type Bitrix24RequestState = 'unresolved' | 'active' | 'converted' | 'archived';

export interface Bitrix24IncomingRequestListItem {
  requestId: number;
  bitrixDealId: string;
  clientId: number | null;
  clientName: string | null;
  title: string;
  crmAmount?: number | null;
  currencyId?: string | null;
  stageId: string | null;
  assignedById: string | null;
  bitrixUrl: string;
  state: Bitrix24RequestState;
  linkedOrderId: number | null;
  linkedOrderKind: 'crm_request' | 'production_order' | null;
  projectId: number | null;
  projectCode: string | null;
  fullNumber: string | null;
  syncStatus: 'ok' | 'blocked';
  syncErrorCode: string | null;
  detailCount: number;
  erpFinalAmount?: number | null;
  orderVersion: number | null;
  bitrixCreatedAt: string | null;
  bitrixUpdatedAt: string | null;
  paymentCount?: number;
  paymentAmount?: number;
}

export interface Bitrix24IncomingPayment {
  bitrixPaymentId: string;
  paySystemId: number | null;
  paySystemName: string | null;
  amount: number;
  currencyId: string | null;
  paid: boolean;
  paymentDate: string | null;
  state: 'active' | 'deleted' | 'materialized';
  erpPaymentId: number | null;
  mappedTypePaidId: number | null;
  source?: 'widget' | 'native';
  commandStatus?: string | null;
}

export type Bitrix24MappedOrderPayments =
  | { linked: false; orderId: number }
  | {
      linked: true;
      orderId: number;
      orderVersion: number;
      bitrixDealId: string;
      bitrixUrl: string;
      lastReconciledAt: string | null;
      payments: Bitrix24IncomingPayment[];
    };

export interface Bitrix24IncomingRequestDetail {
  id: number;
  detailNumber: number;
  detailName: string | null;
  height: number;
  width: number;
  quantity: number;
  area: number;
  sheetMaterialTypeId: number;
  millingTypeId: number;
  edgeTypeId: number;
  filmId: number | null;
  millingCostPerSqm?: number | null;
  detailCost?: number | null;
  priority: number;
  note: string | null;
}

export type Bitrix24IncomingRequestDetailInput = Omit<
  Bitrix24IncomingRequestDetail,
  'id' | 'detailNumber' | 'area'
> & { id?: number };

export interface Bitrix24IncomingRequest extends Bitrix24IncomingRequestListItem {
  stageName: string | null;
  assignedByName: string | null;
  beginDate: string | null;
  closeDate: string | null;
  comments: string | null;
  version: number;
  details: Bitrix24IncomingRequestDetail[];
  payments: Bitrix24IncomingPayment[];
}

export interface Bitrix24IncomingRequestListResponse {
  data: Bitrix24IncomingRequestListItem[];
  pagination: {
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
  };
}

export interface Bitrix24PaymentTypeMapping {
  paySystemId: number;
  paySystemName: string | null;
  typePaidId: number | null;
  typePaidName: string | null;
  active: boolean;
  widgetEnabled: boolean;
  isDefault: boolean;
  lastFetchedAt: string | null;
}

export interface Bitrix24UserMapping {
  mappingId: number;
  bitrixUserId: string;
  erpUserId: number;
  erpUsername: string;
  erpFullName: string | null;
  active: boolean;
  updatedAt: string;
}

export interface Bitrix24UserMappingTarget {
  userId: number;
  username: string;
  fullName: string | null;
  role: string;
}

export interface Bitrix24SyncHealth {
  queue: {
    pending: number;
    processing: number;
    failed: number;
    dead: number;
  };
  lastProcessedAt: string | null;
  lastReconcileAt: string | null;
  installationStatus: string | null;
  tokenExpiresAt: string | null;
  lastError: string | null;
  widget: {
    lastSubmitAt: string | null;
    awaitingOrder: number;
    awaitingRetry: number;
    ambiguous: number;
  };
  paymentSystemCatalogLastFetchedAt: string | null;
}

export interface Bitrix24AmbiguousPaymentCommand {
  commandId: string;
  bitrixDealId: string;
  bitrixActorUserId: string;
  erpActorUserId: number;
  amount: string;
  currencyId: string;
  paymentDate: string;
  paySystemId: number;
  beforePaymentIds: string[];
  diagnosticCandidateIds: string[];
  version: number;
  errorCode: string | null;
  createdAt: string;
}

export const bitrix24Api = {
  listIncomingRequests(params: {
    state?: Bitrix24RequestState;
    search?: string;
    stageId?: string;
    assignedById?: string;
    clientId?: number;
    updatedFrom?: string;
    updatedTo?: string;
    page?: number;
    pageSize?: number;
  } = {}): Promise<Bitrix24IncomingRequestListResponse> {
    const query = new URLSearchParams();
    if (params.state) query.set('state', params.state);
    if (params.search) query.set('search', params.search);
    if (params.stageId) query.set('stageId', params.stageId);
    if (params.assignedById) query.set('assignedById', params.assignedById);
    if (params.clientId) query.set('clientId', String(params.clientId));
    if (params.updatedFrom) query.set('updatedFrom', params.updatedFrom);
    if (params.updatedTo) query.set('updatedTo', params.updatedTo);
    if (params.page) query.set('page', String(params.page));
    if (params.pageSize) query.set('pageSize', String(params.pageSize));
    const suffix = query.size ? `?${query.toString()}` : '';
    return httpClient.get(`${apiRoutes.bitrix24.incomingRequests}${suffix}`);
  },

  getIncomingRequest(requestId: number): Promise<Bitrix24IncomingRequest> {
    return httpClient.get(apiRoutes.bitrix24.incomingRequest(validId(requestId)));
  },

  replaceIncomingRequestDetails(
    requestId: number,
    input: {
      orderVersion: number;
      details: Bitrix24IncomingRequestDetailInput[];
    },
  ): Promise<{
    orderId: number;
    orderVersion: number;
    detailCount: number;
    erpFinalAmount?: number;
    details: Bitrix24IncomingRequestDetail[];
  }> {
    return httpClient.put(
      apiRoutes.bitrix24.incomingRequestDetails(validId(requestId)),
      input,
    );
  },

  materializePayments(
    requestId: number,
    input: { bitrixPaymentIds: string[]; expectedOrderVersion: number },
  ): Promise<Bitrix24IncomingRequest> {
    return httpClient.post(
      apiRoutes.bitrix24.materializePayments(validId(requestId)),
      input,
    );
  },

  archiveIncomingRequest(
    requestId: number,
    orderVersion: number,
  ): Promise<{
    requestId: number;
    orderId: number;
    state: 'archived';
    archivedBySource: 'erp_user';
    orderVersion: number;
  }> {
    return httpClient.post(
      apiRoutes.bitrix24.archiveIncomingRequest(validId(requestId)),
      { orderVersion },
    );
  },

  materializeMappedOrderPayments(
    orderId: number,
    input: { bitrixPaymentIds: string[]; expectedOrderVersion: number },
  ): Promise<{
    orderId: number;
    changedPaymentCount: number;
    deletedPaymentCount: number;
  }> {
    return httpClient.post(
      apiRoutes.bitrix24.materializeMappedOrderPayments(validId(orderId)),
      input,
    );
  },

  getMappedOrderPayments(orderId: number): Promise<Bitrix24MappedOrderPayments> {
    return httpClient.get(apiRoutes.bitrix24.mappedOrderPayments(validId(orderId)));
  },

  reconcileMappedOrderPayments(orderId: number): Promise<Bitrix24MappedOrderPayments> {
    return httpClient.post(
      apiRoutes.bitrix24.reconcileMappedOrderPayments(validId(orderId)),
      {},
    );
  },

  convertToProduction(
    orderId: number,
    input: {
      version: number;
      orderName: string;
      projectId: number | null;
      createProject: boolean;
      idempotencyKey: string;
    },
  ): Promise<{
    orderId: number;
    orderKind: 'production_order';
    projectId: number;
    projectCode: string;
    fullNumber: string;
    version: number;
  }> {
    return httpClient.post(apiRoutes.orders.convertToProduction(validId(orderId)), input);
  },

  listUserMappings(): Promise<Bitrix24UserMapping[]> {
    return httpClient.get(apiRoutes.bitrix24.userMappings);
  },

  listUserMappingTargets(): Promise<Bitrix24UserMappingTarget[]> {
    return httpClient.get(apiRoutes.bitrix24.userMappingTargets);
  },

  updateUserMapping(
    bitrixUserId: string,
    input: { erpUserId: number; active: boolean },
  ): Promise<Bitrix24UserMapping> {
    if (!/^[1-9][0-9]*$/.test(bitrixUserId)) throw new Error('Invalid Bitrix24 user ID');
    return httpClient.put(apiRoutes.bitrix24.userMapping(bitrixUserId), input);
  },

  listPaymentTypeMappings(): Promise<Bitrix24PaymentTypeMapping[]> {
    return httpClient.get(apiRoutes.bitrix24.paymentTypeMappings);
  },

  updatePaymentTypeMapping(
    paySystemId: number,
    input: {
      typePaidId: number;
      active: boolean;
      widgetEnabled?: boolean;
      isDefault?: boolean;
    },
  ): Promise<Bitrix24PaymentTypeMapping> {
    return httpClient.put(
      apiRoutes.bitrix24.paymentTypeMapping(validId(paySystemId)),
      input,
    );
  },

  refreshPaymentSystems(): Promise<{ refreshed: number }> {
    return httpClient.post(apiRoutes.bitrix24.refreshPaymentSystems, {});
  },

  listAmbiguousPaymentCommands(): Promise<Bitrix24AmbiguousPaymentCommand[]> {
    return httpClient.get(apiRoutes.bitrix24.ambiguousPaymentCommands);
  },

  resolvePaymentAmbiguity(
    commandId: string,
    input:
      | { resolution: 'attach_existing'; bitrixPaymentId: string; reason: string; expectedVersion: number }
      | { resolution: 'confirm_absent'; reason: string; expectedVersion: number },
  ): Promise<Record<string, unknown>> {
    return httpClient.post(apiRoutes.bitrix24.resolvePaymentAmbiguity(commandId), input);
  },

  getSyncHealth(): Promise<Bitrix24SyncHealth> {
    return httpClient.get(apiRoutes.bitrix24.syncHealth);
  },

  retryFailed(): Promise<{ retried: number }> {
    return httpClient.post(apiRoutes.bitrix24.retryFailed, {});
  },
};

function validId(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error('Invalid Bitrix24 ID');
  return value;
}
